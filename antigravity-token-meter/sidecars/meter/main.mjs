/**
 * Antigravity TokenMeter 主入口（MIT License，安全加固版）。
 *
 * 运行模式：
 * 1. 宿主 Sidecar 模式（ANTIGRAVITY_SIDECAR_WEB_PORT 存在）：
 *    - 通过官方 sidecar_sdk 托管侧边栏 Web UI；
 *    - 仅向宿主注入的本地 LS 端点发起 RPC，绝不盲扫进程；
 *    - 使用 OwnerLease 租约锁仲裁单写者与唯一 CDP 内嵌桥所有权，多窗口副实例共享读取实时挂载状态并支持原子更新偏好；
 * 2. 独立本地预览模式（须显式传入 --preview）：
 *    - 默认只读（不篡改真实账本与偏好），并要求随机会话 Token 鉴权。
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { resolvePaths, readPluginFlags } from './src/paths.mjs';
import { OwnerLease, isPidAlive } from './src/owner-lock.mjs';
import { LanguageServerClient, isLoopbackPortOpen } from './src/ls-client.mjs';
import { projectUserStatus, selectQuotaPair, computeConversationTelemetry } from './src/telemetry.mjs';
import { UsageLedger } from './src/ledger.mjs';
import { PreferencesStore } from './src/prefs.mjs';
import { CdpInlineBridge } from './src/cdp-bridge.mjs';
import { I18N_DICT } from './src/i18n.mjs';
import { buildInlineWidgetScript } from './src/ui/inline-bar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
const VERSION = String(PKG.version || '1.2.15');
const IS_HOST_SIDECAR = Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
const IS_PREVIEW = process.argv.includes('--preview');
const PROCESS_STARTED_AT = Date.now();

if (IS_HOST_SIDECAR && IS_PREVIEW) {
  console.error('[TokenMeter] 宿主 sidecar 模式与 --preview 模式互斥，已拒绝启动。');
  process.exit(1);
}
if (!IS_HOST_SIDECAR && !IS_PREVIEW) {
  console.error('[TokenMeter] 未检测到 Antigravity sidecar 环境变量。如需独立本地只读预览，请执行: node main.mjs --preview');
  process.exit(1);
}

const paths = resolvePaths();
const lsClient = new LanguageServerClient();
const ownerLease = IS_HOST_SIDECAR
  ? new OwnerLease(paths.ownerLockFile, { lsPort: lsClient.configuredEndpoint?.port ?? null })
  : null;
const ledger = new UsageLedger(paths.ledgerFile, { readOnly: IS_PREVIEW });
const prefsStore = new PreferencesStore(paths.prefsFile, { readOnly: IS_PREVIEW });

const PANEL_HTML = readFileSync(join(HERE, 'src', 'ui', 'panel.html'), 'utf8');
const PANEL_JS = readFileSync(join(HERE, 'src', 'ui', 'panel.js'), 'utf8');
const I18N_JS = `window.__AG_TM_I18N__=${JSON.stringify(I18N_DICT)};`;

// 仅缓存脱敏投影（不含邮箱、原始 userStatus 敏感字段），带 single-flight、短 TTL 与持久模型名映射兜底
let userStatusProjection = null;
let userStatusFetchedAt = 0;
let userStatusInflight = null;
const knownModelLabels = new Map();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 轨迹摘要短缓存（single-flight + 2s TTL），避免多窗口并发轮询时重复序列化大型轨迹列表
let trajCache = null;
let trajFetchedAt = 0;
let trajInflight = null;

// 最近活跃会话遥测微缓存（最多 24 条，30s 宽限期），彻底消除偶发单次 RPC 超时造成的底栏闪烁
const recentConversations = new Map();
const backfilledMtime = new Map();

// 串行化账本水位线读取与增量入账，杜绝实时会话与后台历史回填并发交叉
let ledgerIngestChain = Promise.resolve();
function enqueueLedgerIngest(fn) {
  const next = ledgerIngestChain.then(fn, fn);
  ledgerIngestChain = next.catch(() => {});
  return next;
}

function rememberConversation(cid, publicConv) {
  if (!cid || !publicConv) return;
  if (recentConversations.has(cid)) recentConversations.delete(cid);
  recentConversations.set(cid, { conv: publicConv, at: Date.now() });
  while (recentConversations.size > 24) {
    const oldest = recentConversations.keys().next().value;
    if (oldest === undefined) break;
    recentConversations.delete(oldest);
  }
}

function getRecentConversation(cid, maxAgeMs = 30000) {
  if (!cid) return null;
  const hit = recentConversations.get(cid);
  if (!hit) return null;
  if (Date.now() - hit.at > maxAgeMs) {
    recentConversations.delete(cid);
    return null;
  }
  return hit.conv;
}

function refreshUserStatusInBackground() {
  if (userStatusInflight) return userStatusInflight;
  userStatusInflight = (async () => {
    try {
      const [statusRes, summaryRes] = await Promise.all([
        lsClient.getUserStatus(3800),
        lsClient.retrieveUserQuotaSummary(false, 2500).catch(() => null),
      ]);
      if (statusRes?.userStatus || summaryRes) {
        const projected = projectUserStatus(statusRes?.userStatus || null, Date.now(), summaryRes);
        if (projected.labelMap instanceof Map) {
          for (const [k, v] of projected.labelMap.entries()) {
            knownModelLabels.set(k, v);
          }
          // 用累积已知映射补齐，防止某次仅返回 quotaSummary 时丢失模型展示名映射
          for (const [k, v] of knownModelLabels.entries()) {
            if (!projected.labelMap.has(k)) projected.labelMap.set(k, v);
          }
        }
        userStatusProjection = projected;
        userStatusFetchedAt = Date.now();
        return { projection: userStatusProjection, fresh: true };
      }
    } catch {
      // 超出 2 分钟过期后清空旧配额投影，避免离线时长期展示过期额度（knownModelLabels 继续保留用于模型名解析）
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
 * 获取脱敏配额与模型标签投影（支持软超时 stale-while-revalidate，绝不因云端配额抖动阻塞本地底栏速率刷新）。
 */
async function fetchUserStatusProjection({ softWaitMs = 1500 } = {}) {
  const now = Date.now();
  if (userStatusProjection && now - userStatusFetchedAt < 15000) {
    return { projection: userStatusProjection, fresh: true };
  }
  const task = refreshUserStatusInBackground();
  const waitMs = userStatusProjection ? Math.min(500, softWaitMs) : softWaitMs;
  if (waitMs <= 0) {
    return {
      projection: userStatusProjection,
      fresh: Boolean(userStatusProjection && now - userStatusFetchedAt < 120000),
    };
  }
  const timedOut = Symbol('soft_timeout');
  const raced = await Promise.race([
    task,
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(timedOut), waitMs);
      t.unref?.();
    }),
  ]);
  if (raced !== timedOut) return raced;
  return {
    projection: userStatusProjection,
    fresh: Boolean(userStatusProjection && Date.now() - userStatusFetchedAt < 120000),
  };
}

async function fetchTrajectorySummaries({ force = false, budgetMs = 2800 } = {}) {
  const now = Date.now();
  if (!force && trajCache && now - trajFetchedAt < 2000) {
    return { summaries: trajCache, ok: true };
  }
  if (!force && trajInflight) return trajInflight;

  const task = (async () => {
    try {
      const trajs = await lsClient.getAllTrajectories(budgetMs);
      const summaries = trajs?.trajectorySummaries && typeof trajs.trajectorySummaries === 'object'
        ? trajs.trajectorySummaries
        : {};
      trajCache = summaries;
      trajFetchedAt = Date.now();
      return { summaries, ok: true };
    } catch {
      if (trajCache && Date.now() - trajFetchedAt < 15000) {
        return { summaries: trajCache, ok: false };
      }
      return { summaries: null, ok: false };
    }
  })();

  if (!force) {
    trajInflight = task.finally(() => {
      if (trajInflight === task) trajInflight = null;
    });
    return trajInflight;
  }
  return task;
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

function eventsContainRawModelEnum(events) {
  return Array.isArray(events) && events.some((ev) => /^(?:MODEL_|PLACEHOLDER_)/i.test(String(ev?.model || '')));
}

function shouldDeferRawEnumIngest(events) {
  if (knownModelLabels.size > 0) return false;
  // 冷启动前 20 秒内若 GetUserStatus 尚未返回模型展示名表，暂缓将内部枚举名（如 MODEL_PLACEHOLDER_*）固化进账本
  if (Date.now() - PROCESS_STARTED_AT > 20000) return false;
  return eventsContainRawModelEnum(events);
}

function isBusinessNotFoundError(err) {
  const code = err?.statusCode;
  return Number.isInteger(code) && code >= 400 && code < 500 && code !== 401 && code !== 403;
}

async function readStatusFileJson() {
  if (!paths.statusFile) return null;
  try {
    const raw = await readFile(paths.statusFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// 多窗口副 sidecar 实例共享读取主实例落盘的挂载状态，消除副窗口侧边栏假黄灯告警
let peerStatusCache = null;
let peerStatusReadAt = 0;
async function resolveIntegrationStatus(flags) {
  if (!flags.enabled || !flags.inline) {
    return {
      state: 'disabled',
      code: 'inline_disabled',
      windows: 0,
      cdpPort: null,
      pid: process.pid,
      checkedAt: new Date().toISOString(),
    };
  }
  if (!IS_HOST_SIDECAR || !ownerLease || ownerLease.owned) {
    return bridge.status;
  }
  const now = Date.now();
  if (peerStatusCache && now - peerStatusReadAt < 2000) {
    return peerStatusCache;
  }
  const parsed = await readStatusFileJson();
  if (parsed) {
    const ageMs = Math.abs(now - Date.parse(parsed.checkedAt || ''));
    if (isPidAlive(Number(parsed.pid)) && ageMs < 30000) {
      peerStatusCache = parsed;
      peerStatusReadAt = now;
      return parsed;
    }
  }
  return bridge.status;
}

/**
 * 采集当前会话与统计快照。
 * 重要：若调用方显式指定了 conversationId 但找不到该会话，或 allowFallback=false（内嵌条新对话首页），
 * 绝不回退到其他旧会话（杜绝串会话），但依然返回全局额度、今日/本月统计与偏好配置。
 */
async function collectSnapshot({ conversationId = undefined, allowFallback = true } = {}) {
  const flags = readPluginFlags(paths);
  if (!flags.enabled) {
    const integration = await resolveIntegrationStatus(flags);
    return { version: VERSION, connected: false, disabled: true, integration };
  }

  // 严格区分“未传入”“传入非法 ID（绝不回退全局最新）”与“合法 UUID”
  const hasExplicitParam = conversationId !== undefined && conversationId !== null && conversationId !== '';
  const explicitCid = hasExplicitParam && typeof conversationId === 'string' && UUID_RE.test(conversationId) ? conversationId : null;
  const invalidExplicit = hasExplicitParam && !explicitCid;

  // 并行发起配额状态、轨迹摘要与（已知会话 ID 时的）单会话元数据查询，消除三段串行阻塞
  const statusPromise = fetchUserStatusProjection({ softWaitMs: 1400 });
  const trajPromise = !invalidExplicit ? fetchTrajectorySummaries({ force: false, budgetMs: 2500 }) : Promise.resolve({ summaries: null, ok: false });
  const explicitGmPromise = explicitCid
    ? lsClient.getGeneratorMetadata(explicitCid, 3000).then(
        (res) => ({ ok: true, res, err: null }),
        (err) => ({ ok: false, res: null, err })
      )
    : null;

  const [{ projection, fresh: quotaFresh }, initialTraj] = await Promise.all([statusPromise, trajPromise]);
  let trajRes = initialTraj;

  // 若刚新建的会话尚未出现在 2s 轨迹摘要缓存中，主动强刷一次以立即获取准确的 createdTime / status
  if (explicitCid && trajRes.summaries && !Object.hasOwn(trajRes.summaries, explicitCid)) {
    const refreshed = await fetchTrajectorySummaries({ force: true, budgetMs: 1500 });
    if (refreshed.summaries) trajRes = refreshed;
  }

  const labelMap = projection?.labelMap || knownModelLabels;
  const quotas = projection?.quotas || [];

  let connected = quotaFresh || trajRes.ok;
  let targetCid = explicitCid;
  let targetStatus = '';
  let targetCreatedMs = NaN;
  let summaryLastModified = '';
  let fallbackDate = new Date().toISOString();
  let conversationUnavailable = invalidExplicit || (!explicitCid && !allowFallback);

  const summaries = trajRes.summaries || {};
  if (!invalidExplicit && trajRes.summaries) {
    if (explicitCid) {
      if (Object.hasOwn(summaries, explicitCid)) {
        targetStatus = summaries[explicitCid]?.status || '';
        summaryLastModified = summaries[explicitCid]?.lastModifiedTime || '';
        fallbackDate = summaryLastModified || fallbackDate;
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
        summaryLastModified = ranked[0][1]?.lastModifiedTime || '';
        fallbackDate = summaryLastModified || fallbackDate;
        targetCreatedMs = Date.parse(ranked[0][1]?.createdTime || '');
      }
    }
  }

  let conversation = null;
  if (targetCid && !invalidExplicit) {
    const gmOutcome = explicitGmPromise
      ? await explicitGmPromise
      : await lsClient.getGeneratorMetadata(targetCid, 3000).then(
          (res) => ({ ok: true, res, err: null }),
          (err) => ({ ok: false, res: null, err })
        );

    if (gmOutcome.ok) {
      connected = true;
      const computed = computeConversationTelemetry({
        cascadeId: targetCid,
        status: targetStatus,
        generatorMetadata: gmOutcome.res?.generatorMetadata || [],
        modelLabelMap: labelMap,
        fallbackDate,
      });
      if (!IS_PREVIEW && (!ownerLease || ownerLease.owned) && !shouldDeferRawEnumIngest(computed.ledgerEvents)) {
        try {
          await enqueueLedgerIngest(async () => {
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
          });
          if (!computed.running && summaryLastModified) {
            backfilledMtime.set(targetCid, summaryLastModified);
          }
        } catch {}
      }
      // 剔除内部 ledgerEvents 与原始 cascadeId，不向 UI 透传原始会话 ID
      const { ledgerEvents: _omitEvents, cascadeId: _omitCid, ...publicConv } = computed;
      conversation = publicConv;
      rememberConversation(targetCid, publicConv);
    } else if (isBusinessNotFoundError(gmOutcome.err)) {
      // 宿主 LS 正常响应了 404/400（刚新建对话尚未产生首轮记录），连接在线但当前会话暂无数据
      connected = true;
      if (explicitCid) conversationUnavailable = true;
    } else {
      // 瞬时超时/忙碌时优先回退最近 30s 内的同会话缓存，消除底栏“--”闪断
      const cachedConv = getRecentConversation(targetCid);
      if (cachedConv) {
        conversation = {
          ...cachedConv,
          running: targetStatus ? targetStatus === 'CASCADE_RUN_STATUS_RUNNING' : cachedConv.running,
          stale: true,
        };
        conversationUnavailable = false;
      } else if (explicitCid) {
        conversationUnavailable = true;
      }
    }
  } else if (explicitCid) {
    conversationUnavailable = true;
  }

  if (!connected && lsClient.currentEndpoint) {
    const ep = await lsClient.resolveEndpoint(false, Date.now() + 900);
    if (ep) connected = true;
  }

  const [usage, preferences, integration] = await Promise.all([
    ledger.snapshot(),
    prefsStore.get(),
    resolveIntegrationStatus(flags),
  ]);
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
    integration,
  };
}

const bridge = new CdpInlineBridge({
  profileCandidates: paths.profileCandidates,
  statusFile: IS_HOST_SIDECAR ? paths.statusFile : null,
  widgetCode: buildInlineWidgetScript(),
  getSnapshot: (input) => collectSnapshot(input),
  getPrefs: () => prefsStore.get(),
  setPrefs: (patch) => prefsStore.update(patch),
  getExpectedHubPort: async () => {
    const ep =
      lsClient.currentEndpoint ||
      (await lsClient.resolveEndpoint(false, Date.now() + 1800)) ||
      lsClient.configuredEndpoint;
    return ep?.port ?? null;
  },
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

function stripTransportQueryKeys(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (!Object.hasOwn(data, 'conversationId')) return data;
  const { conversationId: _omit, ...rest } = data;
  return rest;
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
  app.api('/api/integration', () => resolveIntegrationStatus(readPluginFlags(paths)), 'GET');
  app.api('/api/preferences', () => prefsStore.get(), 'GET');
  app.api('/api/preferences', async (data) => {
    try {
      return await prefsStore.update(stripTransportQueryKeys(data));
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_preferences' }), { status: 400, contentType: 'application/json' });
    }
  }, 'POST');

  await app.run();

  let backfillRunning = false;
  let backfillTimer = null;
  let backfillSweepTimer = null;

  /**
   * 后台温和回填本机历史与后台子代理/多窗口会话的 Token 消耗：
   * - 仅持有写租约时执行；
   * - 筛选最近活跃的最多 240 个会话后按【从旧到新】时间正序入账，杜绝历史回填挤占 FIFO 队列导致今日活跃记录被反向驱逐；
   * - 周期性轻量增量巡检，自动吸纳后台 Subagent / Swarm / 自动化会话的新增消耗。
   */
  async function backfillHistoricalTrajectories() {
    if (backfillRunning || IS_PREVIEW || (ownerLease && !ownerLease.owned)) return;
    backfillRunning = true;
    try {
      const { projection } = await fetchUserStatusProjection({ softWaitMs: 2200 });
      const labelMap = projection?.labelMap || knownModelLabels;
      const trajRes = await fetchTrajectorySummaries({ force: true, budgetMs: 3500 });
      if (!trajRes.summaries) return;
      const summaries = trajRes.summaries;

      const [initImportedMs, initEvictedMs] = await Promise.all([
        ledger.getImportedUntilMs(),
        ledger.getEvictedUntilMs(),
      ]);
      const initCutoffMs = Math.max(initImportedMs, initEvictedMs);
      const windowCutoffMs = Math.max(Date.now() - 120 * 86400 * 1000, initCutoffMs);

      // 先取最近活跃的前 240 个候选会话，再反转为按时间从旧到新顺序入账，保证 FIFO 队列尾部始终为最新会话
      const candidates = Object.entries(summaries)
        .filter(([cid, meta]) => {
          if (!UUID_RE.test(cid)) return false;
          const mtime = Date.parse(meta?.lastModifiedTime || '');
          if (Number.isFinite(mtime) && mtime <= windowCutoffMs) return false;
          const isRunning = meta?.status === 'CASCADE_RUN_STATUS_RUNNING';
          if (isRunning) return true;
          const stamp = meta?.lastModifiedTime || '';
          return !stamp || backfilledMtime.get(cid) !== stamp;
        })
        .sort(([, a], [, b]) => Date.parse(b?.lastModifiedTime || 0) - Date.parse(a?.lastModifiedTime || 0))
        .slice(0, 240)
        .reverse();

      for (const [cid, meta] of candidates) {
        if (isShuttingDown || (ownerLease && !ownerLease.owned)) break;
        try {
          const gmRes = await lsClient.getGeneratorMetadata(cid, 3000);
          const computed = computeConversationTelemetry({
            cascadeId: cid,
            status: meta?.status || '',
            generatorMetadata: gmRes?.generatorMetadata || [],
            modelLabelMap: labelMap,
            fallbackDate: meta?.lastModifiedTime || new Date().toISOString(),
          });
          if (shouldDeferRawEnumIngest(computed.ledgerEvents)) {
            continue;
          }
          const convCreatedMs = Date.parse(meta?.createdTime || '');
          await enqueueLedgerIngest(async () => {
            const [importedUntilMs, evictedUntilMs] = await Promise.all([
              ledger.getImportedUntilMs(),
              ledger.getEvictedUntilMs(),
            ]);
            const ledgerCutoffMs = Math.max(importedUntilMs, evictedUntilMs);
            const events = filterFreshLedgerEvents(computed.ledgerEvents, {
              cutoffMs: ledgerCutoffMs,
              convCreatedMs,
            });
            if (events.length > 0) {
              await ledger.ingest(events);
            }
          });
          if (meta?.status !== 'CASCADE_RUN_STATUS_RUNNING' && meta?.lastModifiedTime) {
            backfilledMtime.set(cid, meta.lastModifiedTime);
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 90));
      }
    } catch {
      // 历史回填属于增强能力，失败静默忽略，不影响实时监控
    } finally {
      backfillRunning = false;
    }
  }

  let claimRetryTimer = null;
  let hostLivenessTimer = null;
  let hostDownStreak = 0;
  let isShuttingDown = false;

  /**
   * 判断当前锁持有者是否为上次重启遗留的孤儿 sidecar 进程：
   * - 前提：本进程必须已验证自身绑定的宿主 LS 处于活跃可用状态；
   * - 场景 A（新版互认）：旧锁记录的 lsPort 与本实例不同且已关闭拒绝连接；
   * - 场景 B（兼容旧版无 lsPort 孤儿）：本实例晚于旧锁 >=5s 启动，且旧锁汇报的状态处于失联（reconnecting/starting/stale_port 等）或状态心跳已停更 >15s；
   * - 绝不抢占处于 mounted / waiting_composer 且状态新鲜的同宿主活跃多窗口实例。
   */
  const canTakeoverStaleOwner = async (existing) => {
    if (!existing || existing.pid === process.pid) return false;
    const myEp = await lsClient.resolveEndpoint(false, Date.now() + 1500);
    if (!myEp) return false;

    if (Number.isInteger(existing.lsPort) && existing.lsPort > 0 && existing.lsPort !== myEp.port) {
      const oldLsAlive = await isLoopbackPortOpen(existing.lsPort);
      if (!oldLsAlive) return true;
    }

    const existingStartedAt = Number(existing.startedAt || 0);
    if (existingStartedAt > 0 && ownerLease.startedAt - existingStartedAt >= 5000) {
      const st = await readStatusFileJson();
      if (st && st.pid === existing.pid) {
        const checkedMs = Date.parse(st.checkedAt || '');
        const statusStale = !Number.isFinite(checkedMs) || Date.now() - checkedMs > 15000;
        const disconnected =
          st.state === 'reconnecting' ||
          ['starting', 'stale_port', 'cdp_unreachable', 'no_active_port'].includes(st.code);
        if (disconnected || statusStale) return true;
      } else if (ownerLease.startedAt - existingStartedAt >= 15000) {
        return true;
      }
    }
    return false;
  };

  const stopBackfillTimers = () => {
    if (backfillTimer) {
      clearTimeout(backfillTimer);
      backfillTimer = null;
    }
    if (backfillSweepTimer) {
      clearInterval(backfillSweepTimer);
      backfillSweepTimer = null;
    }
  };

  const scheduleClaimRetry = () => {
    if (claimRetryTimer || isShuttingDown) return;
    claimRetryTimer = setInterval(() => {
      void (async () => {
        if (isShuttingDown) return;
        if (await ownerLease.claim({ canTakeover: canTakeoverStaleOwner })) {
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
    void prefsStore.ensureInitialized().catch(() => {});
    // 解析 LS 端点完成后立即唤醒一次 bridge.tick()，将冷启动挂载延迟从 ~2.5s 缩短至百毫秒级
    void lsClient.resolveEndpoint(false).then((ep) => {
      if (ep && !isShuttingDown && ownerLease?.owned) {
        void bridge.tick();
      }
    });
    bridge.start();
    ownerLease.startHeartbeat(() => {
      stopBackfillTimers();
      void bridge.detachAll();
      // 若因瞬时 IO 冲突失锁且并非关机退出，自动重新进入争锁自愈周期
      scheduleClaimRetry();
    });
    if (!backfillTimer) {
      backfillTimer = setTimeout(() => {
        backfillTimer = null;
        void backfillHistoricalTrajectories();
      }, 2000);
      backfillTimer.unref?.();
    }
    if (!backfillSweepTimer) {
      backfillSweepTimer = setInterval(() => {
        if (!isShuttingDown && ownerLease?.owned) {
          void backfillHistoricalTrajectories();
        }
      }, 45000);
      backfillSweepTimer.unref?.();
    }
  };

  if (await ownerLease.claim({ canTakeover: canTakeoverStaleOwner })) {
    activateOwnership();
  } else {
    // 若快速重启时旧租约尚未过 TTL 或由旧孤儿霸占，定期探测并安全接管
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
        if (hostLivenessTimer) { clearInterval(hostLivenessTimer); hostLivenessTimer = null; }
        stopBackfillTimers();
        await bridge.stop();
        try { await enqueueLedgerIngest(() => ledger.flush()); } catch {}
        await ownerLease.release();
        process.exit(0);
      })();
    }
    return shutdownPromise;
  };

  // 宿主失联与停用自毁守护：
  // 1. 用户在「自定义扩展」点击停用/卸载插件时（enabled=false），旧进程立即释放锁并退出，避免重新启用时新旧进程抢锁延迟；
  // 2. Windows 下重启 Antigravity 时旧 sidecar 偶发残留为孤儿进程，若绑定的宿主 LS 端口连续 3 次（~30s）拒绝连接，则主动释放锁并体面退出。
  const configuredLs = lsClient.configuredEndpoint;
  let livenessTick = 0;
  hostLivenessTimer = setInterval(() => {
    void (async () => {
      if (isShuttingDown) return;
      const flags = readPluginFlags(paths);
      if (!flags.enabled) {
        void shutdown();
        return;
      }
      livenessTick++;
      if (livenessTick % 2 !== 0) return;
      if (!configuredLs || !configuredLs.port) return;
      const alive = await isLoopbackPortOpen(configuredLs.port, configuredLs.hostname);
      if (alive) {
        hostDownStreak = 0;
        return;
      }
      hostDownStreak++;
      if (hostDownStreak >= 3) {
        void shutdown();
      }
    })();
  }, 5000);
  hostLivenessTimer.unref?.();
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
      if (url.pathname === '/api/integration' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(await resolveIntegrationStatus(readPluginFlags(paths))));
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
