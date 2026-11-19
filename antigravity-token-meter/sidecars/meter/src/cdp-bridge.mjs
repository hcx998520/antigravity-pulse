/**
 * 实验性运行时 CDP 内嵌注入引擎（隔离世界 + 代次保护 + 零代理直连）。
 *
 * 安全与稳定性加固：
 * 1. 使用 Page.createIsolatedWorld 创建独立隔离世界，并将 Runtime.addBinding 限制到该 world，
 *    不在宿主默认 JS 世界暴露通信 API 或 ownerToken；
 * 2. 遍历全部候选 profile 目录，遇到过期/不可达端口自动尝试下一个，严格十进制端口校验且禁重定向；
 * 3. 若已知宿主 LS 端口，严格要求目标页面端口与 LS 端口一致，避免错误附加到同调试实例中的其他回环网页；
 * 4. 每次导航递增 docEpoch，请求携带 { docEpoch, contextId } 并在回包前重验，杜绝跨导航错投；
 * 5. stop() 与 tick() 全程检查停止状态与所有权租约，detachAll() 逐项独立清理，状态文件原子替换。
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LoopbackWebSocket } from './local-ws.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const PORT_STR_RE = /^[1-9]\d{0,4}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BINDING_PREFIX = '__agTokenMeterCallV2';
const WORLD_NAME = 'AntigravityTokenMeterWorld';

/**
 * 校验 CDP 目标是否属于可信 Antigravity 本地主窗口。
 * Antigravity 2.33+ 中，language_server 往往独立申请多组临时本地端口：
 * - 有的启动下 HTTPS Hub 与 LS RPC 端口相邻（如 50066 vs 50067）；
 * - 重启后两者可能相隔数千端口（如 LS RPC 53494、CDP 57951、HTTPS Hub 57953）；
 * 因此除严格同端口匹配外，仅对同一 Electron CDP 实例下的本地 HTTPS 页面放行以下三类可信来源：
 * 1. 与 LS RPC 端口相邻（差值 <= 32）；
 * 2. 与 Electron CDP 端口相邻的高端口（>= 10000 且差值 <= 32）；
 * 3. 操作系统动态临时端口段（>= 32768）且窗口标题带有 Antigravity 宿主标识。
 * 同时继续严格拒绝非 HTTPS 回环页面、3000/5173/8080/8443 等常见本地开发服务、无标识高端口页面、远程站点与 iframe。
 * @param {any} target
 * @param {number} cdpPort
 * @param {number | null} [expectedHubPort] 宿主 language_server 端口（用于同端口或可信 HTTPS Hub 端口校验）
 */
export function isTrustedHubTarget(target, cdpPort, expectedHubPort = null) {
  if (!target || typeof target !== 'object' || target.type !== 'page') return false;
  try {
    const pageUrl = new URL(target.url);
    const wsUrl = new URL(target.webSocketDebuggerUrl);
    if (!['http:', 'https:'].includes(pageUrl.protocol) || !LOOPBACK.has(pageUrl.hostname)) return false;
    if (wsUrl.protocol !== 'ws:' || !LOOPBACK.has(wsUrl.hostname)) return false;
    const wsPort = wsUrl.port ? Number(wsUrl.port) : 80;
    if (wsPort !== cdpPort) return false;
    if (expectedHubPort !== null) {
      const pagePort = pageUrl.port ? Number(pageUrl.port) : pageUrl.protocol === 'https:' ? 443 : 80;
      if (pagePort !== expectedHubPort) {
        if (pageUrl.protocol !== 'https:') return false;
        const isAdjacentLsHub = Math.abs(pagePort - expectedHubPort) <= 32;
        const isAdjacentCdpHub = pagePort >= 10000 && Math.abs(pagePort - cdpPort) <= 32;
        const isEphemeralAntigravityWindow =
          pagePort >= 32768 && typeof target.title === 'string' && /\bAntigravity\b/i.test(target.title);
        if (!isAdjacentLsHub && !isAdjacentCdpHub && !isEphemeralAntigravityWindow) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 严格校验隔离世界传入的桥接消息载荷。
 */
export function validateBridgePayload(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!Number.isSafeInteger(parsed.id) || parsed.id < 1) return null;
  if (!['snapshot', 'prefs_get', 'prefs_set'].includes(parsed.type)) return null;
  if (parsed.type === 'snapshot') {
    const cid = parsed.input?.conversationId;
    if (cid != null && (typeof cid !== 'string' || !UUID_RE.test(cid))) return null;
  }
  if (parsed.type === 'prefs_set') {
    if (!parsed.input || typeof parsed.input !== 'object' || Array.isArray(parsed.input)) return null;
  }
  return parsed;
}

/**
 * 零代理、带硬超时、单次结算、禁重定向的本地回环 JSON GET。
 */
function fetchLocalJson(port, path, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (err) reject(err);
      else resolve(val);
    };

    const req = http.request({ hostname: '127.0.0.1', port, family: 4, path, method: 'GET', agent: false }, (res) => {
      if (res.statusCode !== 200) {
        req.destroy();
        finish(new Error(`CDP HTTP ${res.statusCode || 0}`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > 2 * 1024 * 1024) {
          req.destroy();
          finish(new Error('CDP 响应过大'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('aborted', () => finish(new Error('CDP 响应提前中断')));
      res.on('error', (err) => finish(err));
      res.on('end', () => {
        try {
          resolveJson(Buffer.concat(chunks, total).toString('utf8'));
        } catch {
          finish(new Error('CDP 返回非法 JSON'));
        }
      });
      function resolveJson(text) {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error('not array');
        finish(null, parsed);
      }
    });

    const hardTimer = setTimeout(() => {
      req.destroy();
      finish(new Error('CDP 请求超时'));
    }, timeoutMs);
    hardTimer.unref?.();

    req.on('error', (err) => finish(err));
    req.end();
  });
}

/**
 * 依次尝试全部候选 profile 目录：遇到过期端口或不可达端点继续尝试下一个，不锁死发现流程。
 * @param {string[]} profileCandidates
 * @param {{ expectedHubPort?: number | null }} [opts]
 */
export async function discoverHubTargets(profileCandidates, { expectedHubPort = null } = {}) {
  let sawValidPortFile = false;
  let lastReachablePort = null;
  let lastError = null;

  for (const dir of profileCandidates) {
    if (!dir) continue;
    const file = join(dir, 'DevToolsActivePort');
    let content;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (content.length > 1024) continue;
    const lines = content.split(/\r?\n/);
    const portStr = (lines[0] || '').trim();
    const wsPath = (lines[1] || '').trim();
    if (!PORT_STR_RE.test(portStr)) continue;
    const port = Number(portStr);
    if (port < 1 || port > 65535) continue;
    if (wsPath && !wsPath.startsWith('/devtools/')) continue;

    sawValidPortFile = true;
    try {
      const targets = await fetchLocalJson(port, '/json/list');
      lastReachablePort = port;
      const trusted = targets.filter((t) => isTrustedHubTarget(t, port, expectedHubPort));
      if (trusted.length > 0) {
        return { port, activePortFile: file, targets: trusted };
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastReachablePort !== null) {
    return { port: lastReachablePort, activePortFile: null, targets: [] };
  }
  if (!sawValidPortFile) {
    const err = new Error('no_active_port');
    err.diagCode = 'no_active_port';
    throw err;
  }
  const err = new Error(lastError?.message || 'stale_port');
  err.diagCode = 'stale_port';
  throw err;
}

export class CdpSession {
  constructor(wsUrl, { createSocket = (url) => new LoopbackWebSocket(url), onEvent = () => {}, onClose = () => {}, timeoutMs = 4000 } = {}) {
    this.wsUrl = wsUrl;
    this.createSocket = createSocket;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.timeoutMs = timeoutMs;
    this.ws = null;
    this.closed = false;
    this.nextId = 0;
    this.pending = new Map();
  }

  async open() {
    this.ws = this.createSocket(this.wsUrl);
    this.ws.on('message', (text) => {
      if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (Number.isSafeInteger(msg.id)) {
        const slot = this.pending.get(msg.id);
        if (!slot) return;
        this.pending.delete(msg.id);
        clearTimeout(slot.timer);
        if (msg.error) slot.reject(new Error(`CDP ${msg.error.code || 'ERR'}`));
        else slot.resolve(msg.result || {});
      } else if (typeof msg.method === 'string') {
        try {
          this.onEvent(msg);
        } catch {}
      }
    });
    this.ws.on('close', () => this._handleClose());
    await this.ws.connect();
    return this;
  }

  send(method, params = {}) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('cdp_disconnected'));
    }
    if (this.pending.size >= 32) {
      return Promise.reject(new Error('cdp_queue_full'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp_timeout:${method}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  _handleClose() {
    if (this.closed) return;
    this.closed = true;
    for (const slot of this.pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(new Error('cdp_closed'));
    }
    this.pending.clear();
    this.onClose();
  }

  close() {
    this._handleClose();
    try { this.ws?.close(); } catch {}
  }
}

function buildIsolatedBridgeScript(bindingName) {
  return `(function(binding){
    if (window !== window.top) return;
    if (window.__agTokenMeterBridge && window.__agTokenMeterBridge.binding === binding) return;
    try { window.__agTokenMeterBridge?.dispose?.(); } catch {}
    var pending = new Map();
    var seq = 0;
    var offline = function() { return { connected: false, error: 'reconnecting' }; };
    var invoke = function(type, input) {
      return new Promise(function(resolve) {
        if (pending.size >= 6) { resolve(offline()); return; }
        var id = ++seq;
        var timer = setTimeout(function() { pending.delete(id); resolve(offline()); }, 8000);
        pending.set(id, { resolve: resolve, timer: timer });
        try {
          globalThis[binding](JSON.stringify({ id: id, type: type, input: input || {} }));
        } catch (e) {
          clearTimeout(timer);
          pending.delete(id);
          resolve(offline());
        }
      });
    };
    window.__agTokenMeterBridge = {
      binding: binding,
      resolve: function(id, payload) {
        var slot = pending.get(id);
        if (!slot) return;
        clearTimeout(slot.timer);
        pending.delete(id);
        slot.resolve(payload);
      },
      reset: function() {
        pending.forEach(function(slot) { clearTimeout(slot.timer); slot.resolve(offline()); });
        pending.clear();
      },
      dispose: function() {
        pending.forEach(function(slot) { clearTimeout(slot.timer); slot.resolve(offline()); });
        pending.clear();
        delete window.__agTokenMeterBridge;
        delete window.__agTokenMeterApi;
      }
    };
    window.__agTokenMeterApi = {
      getSnapshot: function(conversationId) { return invoke('snapshot', { conversationId: conversationId || null }); },
      getPrefs: function() { return invoke('prefs_get', {}); },
      setPrefs: function(patch) { return invoke('prefs_set', patch || {}); }
    };
  })(${JSON.stringify(bindingName)});`;
}

export function buildInjectableBundle({ widgetCode, bindingName, ownerToken }) {
  const hash = createHash('sha256').update(widgetCode).update(bindingName).update(ownerToken).digest('hex').slice(0, 16);
  const bridge = buildIsolatedBridgeScript(bindingName);
  return `(function(){
    if (window !== window.top) return;
    if (window.__agTokenMeterBundleHash !== ${JSON.stringify(hash)}) {
      try { window.__agTokenMeterDispose?.(); } catch {}
      try { window.__agTokenMeterBridge?.dispose?.(); } catch {}
      window.__agTokenMeterBundleHash = ${JSON.stringify(hash)};
      window.__agTokenMeterOwner = ${JSON.stringify(ownerToken)};
    }
    ${bridge}
    ${widgetCode}
  })();`;
}

export class CdpInlineBridge {
  constructor({
    profileCandidates,
    statusFile = null,
    widgetCode,
    getSnapshot,
    getPrefs,
    setPrefs,
    getExpectedHubPort = () => null,
    isEnabled = () => true,
    hasOwnership = () => true,
    discover = discoverHubTargets,
    createSession = (url, opts) => new CdpSession(url, opts),
    pollIntervalMs = 2500,
  }) {
    this.profileCandidates = profileCandidates;
    this.statusFile = statusFile;
    this.getSnapshot = getSnapshot;
    this.getPrefs = getPrefs;
    this.setPrefs = setPrefs;
    this.getExpectedHubPort = getExpectedHubPort;
    this.isEnabled = isEnabled;
    this.hasOwnership = hasOwnership;
    this.discover = discover;
    this.createSession = createSession;
    this.pollIntervalMs = pollIntervalMs;

    this.ownerToken = randomUUID().replaceAll('-', '').slice(0, 12);
    this.bindingName = `${BINDING_PREFIX}_${this.ownerToken}`;
    this.bundleSource = buildInjectableBundle({
      widgetCode,
      bindingName: this.bindingName,
      ownerToken: this.ownerToken,
    });

    this.sessions = new Map();
    this.running = false;
    this.stopping = false;
    this.busy = false;
    this.timer = null;

    this.status = {
      state: 'starting',
      code: 'starting',
      windows: 0,
      cdpPort: null,
      pid: process.pid,
      checkedAt: new Date().toISOString(),
    };
  }

  async _updateStatus(state, code, extra = {}) {
    this.status = {
      state,
      code,
      windows: this.sessions.size,
      pid: process.pid,
      checkedAt: new Date().toISOString(),
      ...extra,
    };
    if (this.statusFile && this.hasOwnership()) {
      const tmp = `${this.statusFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      try {
        await mkdir(dirname(this.statusFile), { recursive: true });
        await writeFile(tmp, JSON.stringify(this.status, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
        for (let i = 0; i < 3; i++) {
          try {
            await rename(tmp, this.statusFile);
            break;
          } catch (err) {
            const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
            if (!transient || i === 2) throw err;
            await new Promise((r) => setTimeout(r, 40 * (i + 1)));
          }
        }
      } catch {
        try { await unlink(tmp); } catch {}
      }
    }
  }

  async _ensureIsolatedWorld(conn) {
    const epochBefore = conn.docEpoch;
    const res = await conn.send('Page.createIsolatedWorld', {
      frameId: conn.frameId,
      worldName: WORLD_NAME,
      grantUniveralAccess: false,
    });
    if (conn.docEpoch !== epochBefore || this.stopping) throw new Error('epoch_changed');
    const ctxId = res?.executionContextId;
    if (!Number.isSafeInteger(ctxId)) throw new Error('isolated_world_failed');
    conn.worldContextId = ctxId;
    return ctxId;
  }

  async _injectIntoWorld(conn) {
    const ctxId = await this._ensureIsolatedWorld(conn);
    const evalRes = await conn.send('Runtime.evaluate', {
      contextId: ctxId,
      expression: conn.guardedSource,
    });
    if (evalRes?.exceptionDetails) {
      throw new Error('widget_init_exception');
    }
    return ctxId;
  }

  async _handleEvent(conn, msg) {
    if (this.stopping || !this.hasOwnership()) return;
    const p = msg.params || {};

    if (msg.method === 'Page.frameNavigated' && p.frame && !p.frame.parentId) {
      conn.frameId = p.frame.id;
      conn.docEpoch++;
      conn.worldContextId = null;
      conn.mounted = false;
      return;
    }
    if (msg.method === 'Runtime.executionContextsCleared') {
      conn.docEpoch++;
      conn.worldContextId = null;
      conn.mounted = false;
      return;
    }
    if (msg.method === 'Runtime.executionContextCreated') {
      const ctx = p.context;
      if (
        ctx &&
        ctx.name === WORLD_NAME &&
        ctx.auxData?.isDefault === false &&
        (!conn.frameId || !ctx.auxData?.frameId || ctx.auxData.frameId === conn.frameId) &&
        Number.isSafeInteger(ctx.id)
      ) {
        conn.worldContextId = ctx.id;
      }
      return;
    }
    if (msg.method === 'Runtime.executionContextDestroyed') {
      if (p.executionContextId === conn.worldContextId) {
        conn.worldContextId = null;
        conn.mounted = false;
      }
      return;
    }
    if (msg.method !== 'Runtime.bindingCalled') return;
    if (p.name !== this.bindingName || p.executionContextId !== conn.worldContextId) return;
    if (conn.inflight >= 6) return;

    const req = validateBridgePayload(p.payload);
    if (!req) return;

    // 捕获请求发起时的文档代次与上下文 ID，回包前严格重验
    const capturedEpoch = conn.docEpoch;
    const capturedCtxId = p.executionContextId;
    conn.inflight++;

    try {
      let result;
      if (!this.isEnabled() || !this.hasOwnership()) {
        result = { connected: false, disabled: true };
      } else if (req.type === 'snapshot') {
        result = await this.getSnapshot({ conversationId: req.input?.conversationId || null, allowFallback: false });
      } else if (req.type === 'prefs_get') {
        result = await this.getPrefs();
      } else if (req.type === 'prefs_set') {
        result = await this.setPrefs(req.input);
      }

      const serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized, 'utf8') > 900 * 1024) throw new Error('payload_too_large');

      if (!this.stopping && !conn.closed && conn.docEpoch === capturedEpoch && conn.worldContextId === capturedCtxId && this.hasOwnership()) {
        await conn.send('Runtime.evaluate', {
          contextId: capturedCtxId,
          expression: `if(window.__agTokenMeterOwner===${JSON.stringify(this.ownerToken)}){window.__agTokenMeterBridge?.resolve(${req.id},${serialized});}`,
        });
      }
    } catch {
      if (!this.stopping && !conn.closed && conn.docEpoch === capturedEpoch && conn.worldContextId === capturedCtxId && this.hasOwnership()) {
        try {
          await conn.send('Runtime.evaluate', {
            contextId: capturedCtxId,
            expression: `if(window.__agTokenMeterOwner===${JSON.stringify(this.ownerToken)}){window.__agTokenMeterBridge?.resolve(${req.id},{"connected":false,"error":"request_failed"});}`,
          });
        } catch {}
      }
    } finally {
      conn.inflight--;
    }
  }

  async _attach(target) {
    const conn = this.createSession(target.webSocketDebuggerUrl, {
      onEvent: (msg) => { void this._handleEvent(conn, msg); },
    });
    conn.origin = new URL(target.url).origin;
    conn.docEpoch = 1;
    conn.worldContextId = null;
    conn.inflight = 0;
    conn.mounted = false;
    conn.scriptId = null;
    conn.guardedSource = `if(location.origin===${JSON.stringify(conn.origin)}){${this.bundleSource}}`;

    try {
      await conn.open();
      if (this.stopping || !this.hasOwnership()) throw new Error('aborted');

      const tree = await conn.send('Page.getFrameTree');
      conn.frameId = tree?.frameTree?.frame?.id;
      if (!conn.frameId) throw new Error('no_main_frame');

      await conn.send('Page.enable');
      await conn.send('Runtime.enable');
      // 将 binding 严格限定到我们的隔离世界名称，不暴露给宿主主世界脚本
      await conn.send('Runtime.addBinding', { name: this.bindingName, executionContextName: WORLD_NAME });
      const added = await conn.send('Page.addScriptToEvaluateOnNewDocument', {
        source: conn.guardedSource,
        worldName: WORLD_NAME,
      });
      conn.scriptId = added?.identifier || null;
      if (this.stopping || !this.hasOwnership()) throw new Error('aborted');

      await this._injectIntoWorld(conn);
      return conn;
    } catch (err) {
      try { if (conn.scriptId) await conn.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: conn.scriptId }); } catch {}
      try { await conn.send('Runtime.removeBinding', { name: this.bindingName }); } catch {}
      conn.close();
      throw err;
    }
  }

  async _cleanupSession(conn) {
    if (conn.worldContextId) {
      try {
        await conn.send('Runtime.evaluate', {
          contextId: conn.worldContextId,
          expression: `if(window.__agTokenMeterOwner===${JSON.stringify(this.ownerToken)}){window.__agTokenMeterDispose?.();window.__agTokenMeterBridge?.dispose?.();}`,
        });
      } catch {}
    }
    if (conn.scriptId) {
      try { await conn.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: conn.scriptId }); } catch {}
    }
    try { await conn.send('Runtime.removeBinding', { name: this.bindingName }); } catch {}
    conn.close();
  }

  async tick() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    const run = (async () => {
    try {
      if (!this.hasOwnership()) {
        await this.detachAll();
        return;
      }
      if (!this.isEnabled()) {
        await this.detachAll();
        await this._updateStatus('disabled', 'inline_disabled', { cdpPort: null });
        return;
      }

      const expectedHubPort = this.getExpectedHubPort();
      if (expectedHubPort === null) {
        // 未确认宿主 LS 端口前不向任意回环页面盲目附加，杜绝误连其他本地网页
        await this._updateStatus('reconnecting', 'starting', { cdpPort: null });
        return;
      }
      const discovered = await this.discover(this.profileCandidates, { expectedHubPort });
      if (this.stopping || !this.hasOwnership()) return;

      const activeUrls = new Set(discovered.targets.map((t) => t.webSocketDebuggerUrl));
      for (const [url, conn] of this.sessions) {
        if (!activeUrls.has(url) || conn.closed) {
          await this._cleanupSession(conn);
          this.sessions.delete(url);
        }
      }

      // 有界并发附加新窗口，单个慢窗口不阻塞其他窗口
      const attachTasks = discovered.targets.map(async (target) => {
        const existing = this.sessions.get(target.webSocketDebuggerUrl);
        if (existing && existing.origin !== new URL(target.url).origin) {
          await this._cleanupSession(existing);
          this.sessions.delete(target.webSocketDebuggerUrl);
        }
        if (!this.sessions.has(target.webSocketDebuggerUrl)) {
          try {
            const conn = await this._attach(target);
            if (this.stopping || !this.hasOwnership()) {
              await this._cleanupSession(conn);
              return;
            }
            this.sessions.set(target.webSocketDebuggerUrl, conn);
          } catch {}
        }
      });
      await Promise.allSettled(attachTasks);
      if (this.stopping || !this.hasOwnership()) return;

      // 有界并发巡检全部窗口（由服务端探针客观确认挂载状态，不轻信页面自报）
      const probeTasks = [...this.sessions.entries()].map(async ([url, conn]) => {
        try {
          if (!conn.worldContextId) {
            await this._injectIntoWorld(conn);
          }
          const probe = await conn.send('Runtime.evaluate', {
            contextId: conn.worldContextId,
            returnByValue: true,
            expression: `({
              mounted: Boolean(document.getElementById('ag-token-meter-host')?.isConnected),
              installed: Boolean(window.__agTokenMeterMounted),
              bridge: Boolean(window.__agTokenMeterBridge && window.__agTokenMeterBridge.binding === ${JSON.stringify(this.bindingName)})
            })`,
          });
          const v = probe?.result?.value;
          conn.mounted = v?.mounted === true;
          if (v && (!v.installed || !v.bridge)) {
            await this._injectIntoWorld(conn);
          }
        } catch {
          await this._cleanupSession(conn);
          this.sessions.delete(url);
        }
      });
      await Promise.allSettled(probeTasks);

      const anyMounted = [...this.sessions.values()].some((c) => c.mounted);
      if (anyMounted) {
        await this._updateStatus('mounted', 'mounted', { cdpPort: discovered.port });
      } else if (this.sessions.size > 0) {
        await this._updateStatus('waiting_composer', 'waiting_composer', { cdpPort: discovered.port });
      } else {
        await this._updateStatus('no_hub_page', 'no_hub_page', { cdpPort: discovered.port });
      }
    } catch (err) {
      const code = err?.diagCode || 'cdp_unreachable';
      await this._updateStatus('reconnecting', code, { cdpPort: null });
    } finally {
      this.busy = false;
      this._inflightTick = null;
    }
    })();
    this._inflightTick = run;
    return run;
  }

  async detachAll() {
    const list = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(list.map((conn) => this._cleanupSession(conn)));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop() {
    this.running = false;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this._inflightTick) {
      try { await this._inflightTick; } catch {}
    }
    await this.detachAll();
  }
}
