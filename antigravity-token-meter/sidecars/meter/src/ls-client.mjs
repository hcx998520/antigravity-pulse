/**
 * Antigravity 本机 language_server ConnectRPC 零代理直连客户端。
 *
 * 严格安全边界：
 * 1. 仅使用宿主注入的显式回环端点（ANTIGRAVITY_LS_ADDRESS + ANTIGRAVITY_CSRF_TOKEN），
 *    彻底移除任何系统进程扫描或凭据抓取逻辑；
 * 2. 仅允许连接本地回环地址（127.0.0.1 / ::1 / localhost），agent: false 绕过应用层代理；
 * 3. 单次请求与整条重试链共享硬截止时间，防止慢连接阻塞轮询；
 * 4. 端点探测支持本地 GetAllCascadeTrajectories 兜底，外网/云端状态超时不连坐断开本地遥测。
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const SERVICE_PREFIX = '/exa.language_server_pb.LanguageServerService/';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_RPC_BYTES = 16 * 1024 * 1024;

function probeSingleLoopbackPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    const sock = net.createConnection({ host, port, family: host.includes(':') ? 6 : 4 });
    const timer = setTimeout(() => done(false), Math.max(120, Math.min(3000, timeoutMs)));
    timer.unref?.();
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * 极速检测本地回环端口是否仍在监听（零代理、仅允许回环地址，localhost 自动兼容 IPv4/IPv6 双栈，用于判断宿主 LS 是否已退出）。
 * @param {number} port
 * @param {string} [hostname]
 * @param {number} [timeoutMs]
 */
export async function isLoopbackPortOpen(port, hostname = '127.0.0.1', timeoutMs = 800) {
  const cleanHost = String(hostname || '127.0.0.1').replace(/^\[|\]$/g, '');
  if (!LOOPBACK.has(cleanHost) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return false;
  }
  const budget = Math.max(150, Math.min(3000, Number(timeoutMs) || 800));
  if (cleanHost !== 'localhost') {
    return probeSingleLoopbackPort(cleanHost, port, budget);
  }
  const startedAt = Date.now();
  if (await probeSingleLoopbackPort('127.0.0.1', port, budget)) {
    return true;
  }
  const remaining = budget - (Date.now() - startedAt);
  if (remaining < 120) return false;
  return probeSingleLoopbackPort('::1', port, remaining);
}

export function parseLoopbackEndpoint(rawAddr) {
  if (!rawAddr || typeof rawAddr !== 'string') return null;
  const trimmed = rawAddr.trim();
  const hasScheme = trimmed.includes('://');
  const normalized = hasScheme ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(normalized);
    if (!['http:', 'https:'].includes(u.protocol) || !LOOPBACK.has(u.hostname)) return null;
    if (u.username || u.password) return null;
    if (u.pathname && u.pathname !== '/') return null;
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const rawHost = u.hostname.replace(/^\[|\]$/g, '');
    return {
      protocol: hasScheme ? u.protocol : null,
      hostname: rawHost === 'localhost' ? '127.0.0.1' : rawHost,
      port,
    };
  } catch {
    return null;
  }
}

export function postLoopbackRpc({
  protocol,
  hostname = '127.0.0.1',
  port,
  csrfToken,
  method,
  body = {},
  timeoutMs = 4500,
}) {
  const cleanHost = hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK.has(cleanHost)) {
    return Promise.reject(new Error('non_loopback_forbidden'));
  }
  if (!['http:', 'https:'].includes(protocol)) {
    return Promise.reject(new Error('invalid_protocol'));
  }
  const boundedTimeout = Math.max(200, Math.min(10000, Number(timeoutMs) || 4500));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (err) reject(err);
      else resolve(val);
    };

    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const transport = protocol === 'http:' ? http : https;
    const req = transport.request(
      {
        hostname: cleanHost,
        port,
        family: cleanHost.includes(':') ? 6 : 4,
        path: `${SERVICE_PREFIX}${method}`,
        method: 'POST',
        agent: false,
        ...(protocol === 'https:' ? { rejectUnauthorized: false } : {}),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'Connect-Protocol-Version': '1',
          'X-Codeium-Csrf-Token': csrfToken,
        },
      },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          req.destroy();
          const err = new Error(`rpc_http_${res.statusCode || 0}`);
          err.statusCode = res.statusCode;
          finish(err);
          return;
        }
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_RPC_BYTES) {
            req.destroy();
            finish(new Error('rpc_response_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('aborted', () => finish(new Error('rpc_aborted')));
        res.on('error', (err) => finish(err));
        res.on('end', () => {
          const text = Buffer.concat(chunks, total).toString('utf8');
          try {
            const parsed = text ? JSON.parse(text) : {};
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              finish(new Error('rpc_invalid_json'));
              return;
            }
            finish(null, parsed);
          } catch {
            finish(new Error('rpc_invalid_json'));
          }
        });
      }
    );

    const hardTimer = setTimeout(() => {
      req.destroy();
      const err = new Error(`rpc_timeout_${method}`);
      err.isTimeout = true;
      finish(err);
    }, boundedTimeout);
    hardTimer.unref?.();

    req.on('error', (err) => finish(err));
    req.write(payload);
    req.end();
  });
}

export class LanguageServerClient {
  /**
   * @param {{ env?: Record<string, string | undefined>, rpcImpl?: typeof postLoopbackRpc }} [opts]
   */
  constructor({ env = process.env, rpcImpl = postLoopbackRpc } = {}) {
    this.env = env;
    this.rpcImpl = rpcImpl;
    this._resolved = null;
    this._generation = 0;
    this._resolving = null;
  }

  get currentEndpoint() {
    return this._resolved ? { ...this._resolved } : null;
  }

  /**
   * 返回宿主显式注入的回环地址与端口（不含敏感 csrfToken），用于冷启动早期 Hub 端口校验。
   */
  get configuredEndpoint() {
    const envAddr = parseLoopbackEndpoint(this.env.ANTIGRAVITY_LS_ADDRESS);
    if (!envAddr || !this.env.ANTIGRAVITY_CSRF_TOKEN) return null;
    return {
      protocol: envAddr.protocol,
      hostname: envAddr.hostname,
      port: envAddr.port,
    };
  }

  async resolveEndpoint(force = false, deadlineMs = Date.now() + 4000) {
    if (this._resolved && !force) return this._resolved;
    if (this._resolving) return this._resolving;

    this._resolving = (async () => {
      const envAddr = parseLoopbackEndpoint(this.env.ANTIGRAVITY_LS_ADDRESS);
      const envCsrf = this.env.ANTIGRAVITY_CSRF_TOKEN;
      if (!envAddr || !envCsrf) return null;

      const rawAddr = String(this.env.ANTIGRAVITY_LS_ADDRESS || '').trim().toLowerCase();
      const isLocalhostAlias = /^(?:https?:\/\/)?localhost(?::\d+)?\/?$/.test(rawAddr);
      const hostCandidates = isLocalhostAlias ? ['127.0.0.1', '::1'] : [envAddr.hostname];
      const protocols = envAddr.protocol ? [envAddr.protocol] : ['https:', 'http:'];
      const probes = [
        { method: 'GetUserStatus', body: { metadata: { ideName: 'antigravity' } }, capMs: 1800 },
        { method: 'GetAllCascadeTrajectories', body: {}, capMs: 1600 },
      ];

      for (const hostname of hostCandidates) {
        let hostRefused = false;
        for (const protocol of protocols) {
          for (let i = 0; i < probes.length; i++) {
            const remaining = deadlineMs - Date.now();
            if (remaining < 250) break;
            const probe = probes[i];
            try {
              await this.rpcImpl({
                protocol,
                hostname,
                port: envAddr.port,
                csrfToken: envCsrf,
                method: probe.method,
                body: probe.body,
                timeoutMs: Math.min(probe.capMs, remaining),
              });
              this._generation++;
              this._resolved = {
                protocol,
                hostname,
                port: envAddr.port,
                csrfToken: envCsrf,
                generation: this._generation,
              };
              return this._resolved;
            } catch (err) {
              // 若端口拒绝连接、TLS 握手不匹配或 CSRF 鉴权失败，立刻切换协议或下一回环协议栈，不浪费剩余超时预算
              const code = String(err?.code || '');
              const msg = String(err?.message || '');
              const status = err?.statusCode || 0;
              if (code === 'ECONNREFUSED') {
                hostRefused = true;
                break;
              }
              const protocolOrConnErr =
                code === 'ECONNRESET' ||
                code === 'EPIPE' ||
                code === 'EPROTO' ||
                code === 'HPE_INVALID_CONSTANT' ||
                code.startsWith('ERR_SSL_') ||
                code.startsWith('ERR_TLS_') ||
                /ssl|tls|wrong version|socket hang up|protocol/i.test(msg) ||
                status === 401 ||
                status === 403;
              if (protocolOrConnErr) break;
            }
          }
          if (hostRefused) break;
        }
      }
      return null;
    })().finally(() => {
      this._resolving = null;
    });

    return this._resolving;
  }

  async call(method, body = {}, totalBudgetMs = 5000) {
    const deadline = Date.now() + totalBudgetMs;
    let ep = await this.resolveEndpoint(false, deadline);
    if (!ep) throw new Error('ls_unavailable');

    const rem1 = deadline - Date.now();
    if (rem1 < 250) throw new Error('rpc_budget_exhausted');
    try {
      return await this.rpcImpl({ ...ep, method, body, timeoutMs: rem1 });
    } catch (err) {
      // 明确的业务 4xx（如 404 不支持该 RPC 或刚新建会话尚未落盘）说明端点可达，不清空缓存也不重连抖动
      const isClientErr =
        Number.isInteger(err?.statusCode) &&
        err.statusCode >= 400 &&
        err.statusCode < 500 &&
        err.statusCode !== 401 &&
        err.statusCode !== 403;
      if (isClientErr) throw err;

      // 单纯的慢请求超时（如云端配额刷新偶发耗时）不说明本地协议变更，保留已解析端点避免引发雪崩重探
      if (err?.isTimeout === true || String(err?.message || '').startsWith('rpc_timeout_')) {
        throw err;
      }

      if (this._resolved && this._resolved.generation === ep.generation) {
        this._resolved = null;
      }
      const rem2 = deadline - Date.now();
      if (rem2 < 400) throw err;
      ep = await this.resolveEndpoint(false, deadline);
      if (!ep) throw err;
      return await this.rpcImpl({ ...ep, method, body, timeoutMs: Math.max(250, deadline - Date.now()) });
    }
  }

  getUserStatus(budgetMs = 4500) {
    return this.call('GetUserStatus', { metadata: { ideName: 'antigravity' } }, budgetMs);
  }

  retrieveUserQuotaSummary(forceRefresh = false, budgetMs = 2800) {
    return this.call('RetrieveUserQuotaSummary', { request: {}, forceRefresh: Boolean(forceRefresh) }, budgetMs);
  }

  getAllTrajectories(budgetMs = 3500) {
    return this.call('GetAllCascadeTrajectories', {}, budgetMs);
  }

  getGeneratorMetadata(cascadeId, budgetMs = 3200) {
    return this.call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId }, budgetMs);
  }
}
