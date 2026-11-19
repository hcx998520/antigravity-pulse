/**
 * Antigravity TokenMeter 主入口（MIT License，安全加固版）。
 *
 * 运行模式：
 * 1. 宿主 Sidecar 模式（ANTIGRAVITY_SIDECAR_WEB_PORT 存在）：
 *    - 通过官方 sidecar_sdk 托管侧边栏 Web UI；
 *    - 仅向宿主注入的本地 LS 端点发起 RPC，绝不盲扫进程；
 *    - 使用 OwnerLease 租约锁仲裁单写者与唯一 CDP 内嵌桥所有权；
 * 2. 独立本地预览模式（须显式传入 --preview）：
 *    - 默认只读（不篡改真实账本与偏好），并要求随机会话 Token 鉴权。
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { resolvePaths, readPluginFlags } from './src/paths.mjs';
import { OwnerLease } from './src/owner-lock.mjs';
import { LanguageServerClient } from './src/ls-client.mjs';
import { projectUserStatus, selectQuotaPair, computeConversationTelemetry } from './src/telemetry.mjs';
import { UsageLedger } from './src/ledger.mjs';
import { PreferencesStore } from './src/prefs.mjs';
import { CdpInlineBridge } from './src/cdp-bridge.mjs';
import { I18N_DICT } from './src/i18n.mjs';
import { buildInlineWidgetScript } from './src/ui/inline-bar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
const VERSION = String(PKG.version || '1.2.12');
const IS_HOST_SIDECAR = Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
const IS_PREVIEW = process.argv.includes('--preview');

if (IS_HOST_SIDECAR && IS_PREVIEW) {
  console.error('[TokenMeter] 宿主 sidecar 模式与 --preview 模式互斥，已拒绝启动。');
  process.exit(1);
}
if (!IS_HOST_SIDECAR && !IS_PREVIEW) {
  console.error('[TokenMeter] 未检测到 Antigravity sidecar 环境变量。如需独立本地只读预览，请执行: node main.mjs --preview');
  process.exit(1);
}

const paths = resolvePaths();
const ownerLease = IS_HOST_SIDECAR ? new OwnerLease(paths.ownerLockFile) : null;
const lsClient = new LanguageServerClient();
const ledger = new UsageLedger(paths.ledgerFile, { readOnly: IS_PREVIEW });
const prefsStore = new PreferencesStore(paths.prefsFile, { readOnly: IS_PREVIEW });

const PANEL_HTML = readFileSync(join(HERE, 'src', 'ui', 'panel.html'), 'utf8');
const PANEL_JS = readFileSync(join(HERE, 'src', 'ui', 'panel.js'), 'utf8');
const I18N_JS = `window.__AG_TM_I18N__=${JSON.stringify(I18N_DICT)};`;

// 仅缓存脱敏投影（不含邮箱、原始 userStatus 敏感字段），带 single-flight 与短 TTL
let userStatusProjection = null;
let userStatusFetchedAt = 0;
let userStatusInflight = null;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fetchUserStatusProjection() {
  const now = Date.now();
  if (userStatusProjection && now - userStatusFetchedAt < 15000) {
    return { projection: userStatusProjection, fresh: true };
  }
  if (userStatusInflight) return userStatusInflight;

  userStatusInflight = (async () => {
    try {
      const [statusRes, summaryRes] = await Promise.all([
        lsClient.getUserStatus(),
        lsClient.retrieveUserQuotaSummary(false).catch(() => null),
      ]);
      if (statusRes?.userStatus || summaryRes) {
        userStatusProjection = projectUserStatus(statusRes?.userStatus || null, Date.now(), summaryRes);
        userStatusFetchedAt = Date.now();
        return { projection: userStatusProjection, fresh: true };
      }
    } catch {
      // 超出 2 分钟过期后清空旧投影，避免离线时长期展示过期状态
      if (Date.now() - userStatusFetchedAt > 120000) {
        userStatusProjection = null;
      }
    }
    return { projection: userStatusProjection, fresh: false };
  })().finally(() => {
    userStatusInflight = null;
  });

  return userStatusInflight;
}

/**
 * 统一过滤应当入账的新鲜事件：严格跳过早于历史导入水位线或已被 FIFO 驱逐的老记录，
 * 并在缺少单步精确时间戳时检查会话创建时间，彻底防止续聊旧会话将历史消费双记到今天。
 */
function filterFreshLedgerEvents(events, { cutoffMs = 0, convCreatedMs = NaN } = {}) {
  if (!Array.isArray(events) || events.length === 0) return [];
  if (!Number.isFinite(cutoffMs) || cutoffMs <= 0) return events;
  return events.filter((ev) => {
    const t = Date.parse(ev.timestamp || '');
    if (!Number.isFinite(t) || t <= cutoffMs) return false;
    if (ev.hasExactTimestamp) return true;
    return Number.isFinite(convCreatedMs) ? convCreatedMs > cutoffMs : false;
  });
}

/**
 * 采集当前会话与统计快照。
 * 重要：若调用方显式指定了 conversationId 但找不到该会话，或 allowFallback=false（内嵌条新对话首页），
 * 绝不回退到其他旧会话（杜绝串会话），但依然返回全局额度、今日/本月统计与偏好配置。
 */
async function collectSnapshot({ conversationId = undefined, allowFallback = true } = {}) {
  const flags = readPluginFlags(paths);
  if (!flags.enabled) {
    return { version: VERSION, connected: false, disabled: true, integration: bridge.status };
  }

  // 严格区分“未传入”“传入非法 ID（绝不回退全局最新）”与“合法 UUID”
  const hasExplicitParam = conversationId !== undefined && conversationId !== null && conversationId !== '';
  const explicitCid = hasExplicitParam && typeof conversationId === 'string' && UUID_RE.test(conversationId) ? conversationId : null;
  const invalidExplicit = hasExplicitParam && !explicitCid;

  const { projection, fresh: quotaFresh } = await fetchUserStatusProjection();
  const labelMap = projection?.labelMap || new Map();
  const quotas = projection?.quotas || [];

  let connected = quotaFresh;
  let targetCid = explicitCid;
  let targetStatus = '';
  let targetCreatedMs = NaN;
  let fallbackDate = new Date().toISOString();
  let conversationUnavailable = invalidExplicit || (!explicitCid && !allowFallback);

  if (!invalidExplicit && (explicitCid || allowFallback)) {
    try {
      const trajs = await lsClient.getAllTrajectories();
      const summaries = trajs?.trajectorySummaries || {};
      connected = true;

      if (explicitCid) {
        if (Object.hasOwn(summaries, explicitCid)) {
          targetStatus = summaries[explicitCid]?.status || '';
          fallbackDate = summaries[explicitCid]?.lastModifiedTime || fallbackDate;
          targetCreatedMs = Date.parse(summaries[explicitCid]?.createdTime || '');
        }
      } else if (allowFallback) {
        const ranked = Object.entries(summaries).sort(([, a], [, b]) => {
          const aRun = a?.status === 'CASCADE_RUN_STATUS_RUNNING' ? 1 : 0;
          const bRun = b?.status === 'CASCADE_RUN_STATUS_RUNNING' ? 1 : 0;
          if (aRun !== bRun) return bRun - aRun;
          return Date.parse(b?.lastModifiedTime || 0) - Date.parse(a?.lastModifiedTime || 0);
        });
        if (ranked.length > 0) {
          targetCid = ranked[0][0];
          targetStatus = ranked[0][1]?.status || '';
          fallbackDate = ranked[0][1]?.lastModifiedTime || fallbackDate;
          targetCreatedMs = Date.parse(ranked[0][1]?.createdTime || '');
        }
      }
    } catch {}
  }

  let conversation = null;
  if (targetCid && !invalidExplicit) {
    try {
      const gmRes = await lsClient.getGeneratorMetadata(targetCid);
      connected = true;
      const computed = computeConversationTelemetry({
        cascadeId: targetCid,
        status: targetStatus,
        generatorMetadata: gmRes?.generatorMetadata || [],
        modelLabelMap: labelMap,
        fallbackDate,
      });
      if (!IS_PREVIEW && (!ownerLease || ownerLease.owned)) {
        try {
          const [importedUntilMs, evictedUntilMs] = await Promise.all([
            ledger.getImportedUntilMs(),
            ledger.getEvictedUntilMs(),
          ]);
          const cutoffMs = Math.max(importedUntilMs, evictedUntilMs);
          const freshEvents = filterFreshLedgerEvents(computed.ledgerEvents, {
            cutoffMs,
            convCreatedMs: targetCreatedMs,
          });
          if (freshEvents.length > 0) {
            await ledger.ingest(freshEvents);
          }
        } catch {}
      }
      // 剔除内部 ledgerEvents 与原始 cascadeId，不向 UI 透传原始会话 ID
      const { ledgerEvents: _omitEvents, cascadeId: _omitCid, ...publicConv } = computed;
      conversation = publicConv;
    } catch {
      if (explicitCid) conversationUnavailable = true;
    }
  } else if (explicitCid) {
    conversationUnavailable = true;
  }

  const usage = await ledger.snapshot();
  const preferences = await prefsStore.get();
  const quotaPair = selectQuotaPair(quotas, conversation?.model || null);

  return {
    version: VERSION,
    connected,
    conversationUnavailable,
    conversation,
    quotas,
    quotaPair,
    usage,
    preferences,
    integration: bridge.status,
  };
}

const bridge = new CdpInlineBridge({
  profileCandidates: paths.profileCandidates,
  statusFile: IS_HOST_SIDECAR ? paths.statusFile : null,
  widgetCode: buildInlineWidgetScript(),
  getSnapshot: (input) => collectSnapshot(input),
  getPrefs: () => prefsStore.get(),
  setPrefs: (patch) => prefsStore.update(patch),
  getExpectedHubPort: () => lsClient.currentEndpoint?.port ?? null,
  isEnabled: () => {
    const f = readPluginFlags(paths);
    return f.enabled && f.inline;
  },
  hasOwnership: () => (ownerLease ? ownerLease.owned : false),
});

async function loadOfficialSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' && err?.code !== 'MODULE_NOT_FOUND') throw err;
    const candidates = [
      join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'),
      join(homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs'),
    ];
    for (const file of candidates) {
      if (existsSync(file)) {
        return await import(pathToFileURL(file).href);
      }
    }
    throw new Error('未找到 Antigravity 官方 sidecar_sdk');
  }
}

if (IS_HOST_SIDECAR) {
  const { SidecarApp, Response } = await loadOfficialSidecarSdk();
  const app = new SidecarApp();

  const htmlHeaders = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  app.api('/', () => new Response(PANEL_HTML, { contentType: 'text/html; charset=utf-8', headers: htmlHeaders }), 'GET');
  app.page('/panel.js', () => new Response(PANEL_JS, { contentType: 'application/javascript; charset=utf-8', headers: htmlHeaders }));
  app.page('/i18n.js', () => new Response(I18N_JS, { contentType: 'application/javascript; charset=utf-8', headers: htmlHeaders }));
  app.api('/api/snapshot', (data) => collectSnapshot({ conversationId: data?.conversationId || null }), 'GET');
  app.api('/api/integration', () => bridge.status, 'GET');
  app.api('/api/preferences', () => prefsStore.get(), 'GET');
  app.api('/api/preferences', async (data) => {
    if (ownerLease && !ownerLease.owned) {
      return new Response(JSON.stringify({ error: 'not_owner' }), { status: 409, contentType: 'application/json' });
    }
    try {
      return await prefsStore.update(data);
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_preferences' }), { status: 400, contentType: 'application/json' });
    }
  }, 'POST');

  await app.run();

  const backfilledMtime = new Map();
  let backfillRunning = false;
  let backfillTimer = null;

  /**
   * 后台温和回填本机历史会话的 Token 消耗（仅持有写租约时执行，严格跳过 importedUntil 之前已导入的历史防重复）。
   */
  async function backfillHistoricalTrajectories() {
    if (backfillRunning || IS_PREVIEW || (ownerLease && !ownerLease.owned)) return;
    backfillRunning = true;
    try {
      const { projection } = await fetchUserStatusProjection();
      const labelMap = projection?.labelMap || new Map();
      const trajs = await lsClient.getAllTrajectories();
      const summaries = trajs?.trajectorySummaries || {};
      const [importedUntilMs, evictedUntilMs] = await Promise.all([
        ledger.getImportedUntilMs(),
        ledger.getEvictedUntilMs(),
      ]);
      const ledgerCutoffMs = Math.max(importedUntilMs, evictedUntilMs);
      const cutoffMs = Math.max(Date.now() - 120 * 86400 * 1000, ledgerCutoffMs);

      const candidates = Object.entries(summaries)
        .filter(([cid, meta]) => {
          if (!UUID_RE.test(cid)) return false;
          const mtime = Date.parse(meta?.lastModifiedTime || '');
          if (Number.isFinite(mtime) && mtime <= cutoffMs) return false;
          return backfilledMtime.get(cid) !== (meta?.lastModifiedTime || '1');
        })
        .sort(([, a], [, b]) => Date.parse(b?.lastModifiedTime || 0) - Date.parse(a?.lastModifiedTime || 0))
        .slice(0, 240);

      for (const [cid, meta] of candidates) {
        if (ownerLease && !ownerLease.owned) break;
        try {
          const gmRes = await lsClient.getGeneratorMetadata(cid);
          const computed = computeConversationTelemetry({
            cascadeId: cid,
            status: meta?.status || '',
            generatorMetadata: gmRes?.generatorMetadata || [],
            modelLabelMap: labelMap,
            fallbackDate: meta?.lastModifiedTime || new Date().toISOString(),
          });
          const convCreatedMs = Date.parse(meta?.createdTime || '');
          const events = filterFreshLedgerEvents(computed.ledgerEvents, {
            cutoffMs: ledgerCutoffMs,
            convCreatedMs,
          });
          if (events.length > 0) {
            await ledger.ingest(events);
          }
          backfilledMtime.set(cid, meta?.lastModifiedTime || '1');
        } catch {}
        await new Promise((r) => setTimeout(r, 120));
      }
    } catch {
      // 历史回填属于增强能力，失败静默忽略，不影响实时监控
    } finally {
      backfillRunning = false;
    }
  }

  let claimRetryTimer = null;
  let isShuttingDown = false;
  const scheduleClaimRetry = () => {
    if (claimRetryTimer || isShuttingDown) return;
    claimRetryTimer = setInterval(() => {
      void (async () => {
        if (isShuttingDown) return;
        if (await ownerLease.claim()) {
          activateOwnership();
        }
      })();
    }, 4000);
    claimRetryTimer.unref?.();
  };

  const activateOwnership = () => {
    if (claimRetryTimer) {
      clearInterval(claimRetryTimer);
      claimRetryTimer = null;
    }
    // 先尝试解析一次 LS 端点，让 bridge 尽快获得可信 expectedHubPort
    void lsClient.resolveEndpoint(false);
    bridge.start();
    ownerLease.startHeartbeat(() => {
      void bridge.detachAll();
      // 若因瞬时 IO 冲突失锁且并非关机退出，自动重新进入争锁自愈周期
      scheduleClaimRetry();
    });
    if (!backfillTimer) {
      backfillTimer = setTimeout(() => {
        backfillTimer = null;
        void backfillHistoricalTrajectories();
      }, 2500);
      backfillTimer.unref?.();
    }
  };

  if (await ownerLease.claim()) {
    activateOwnership();
  } else {
    // 若快速重启时旧租约尚未过 TTL，定期重试接管，避免整个生命周期无法挂载
    scheduleClaimRetry();
  }

  let shutdownPromise = null;
  const shutdown = () => {
    isShuttingDown = true;
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        const guard = setTimeout(() => process.exit(0), 8000);
        guard.unref?.();
        if (claimRetryTimer) { clearInterval(claimRetryTimer); claimRetryTimer = null; }
        if (backfillTimer) { clearTimeout(backfillTimer); backfillTimer = null; }
        await bridge.stop();
        try { await ledger.flush(); } catch {}
        await ownerLease.release();
        process.exit(0);
      })();
    }
    return shutdownPromise;
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => { void shutdown(); });
  }
} else {
  // 显式 --preview 只读本地预览（要求一次性会话 Token 与严格来源校验）
  const rawPort = Number(process.env.AG_TM_PORT || 17920);
  const port = Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535 ? rawPort : 17920;
  const previewToken = randomBytes(16).toString('hex');

  const server = createServer((req, res) => {
    void (async () => {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
        res.writeHead(403);
        res.end();
        return;
      }
      let url;
      try {
        url = new URL(req.url || '/', `http://${host}`);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"error":"bad_request"}');
        return;
      }
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) {
        res.writeHead(403);
        res.end();
        return;
      }

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'");

      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PANEL_HTML);
        return;
      }
      if (url.pathname === '/panel.js' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(PANEL_JS);
        return;
      }
      if (url.pathname === '/i18n.js' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(I18N_JS);
        return;
      }

      const providedToken = req.headers['x-sidecar-token'] || url.searchParams.get('token');
      if (providedToken !== previewToken) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"error":"unauthorized"}');
        return;
      }

      if (url.pathname === '/api/snapshot' && req.method === 'GET') {
        const snap = await collectSnapshot({ conversationId: url.searchParams.get('conversationId') });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(snap));
        return;
      }
      if (url.pathname === '/api/preferences' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(await prefsStore.get()));
        return;
      }
      if (url.pathname === '/api/preferences' && req.method === 'POST') {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"error":"preview_readonly"}');
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      if (!res.writableEnded) res.end('{"error":"internal_error"}');
    });
  });

  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    console.log(`[TokenMeter] 只读预览已启动: http://127.0.0.1:${addr.port}/?token=${previewToken}`);
  });
}
