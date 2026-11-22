import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  CdpInlineBridge,
  buildInjectableBundle,
  discoverHubTargets,
  isTrustedHubTarget,
  validateBridgePayload,
} from '../src/cdp-bridge.mjs';
import { LanguageServerClient, parseLoopbackEndpoint } from '../src/ls-client.mjs';

const METER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_DIR = dirname(dirname(METER_DIR));

function mockTarget(id = 'p1', cdpPort = 54321, hubPort = 53150) {
  return {
    type: 'page',
    url: `https://127.0.0.1:${hubPort}/c/11111111-1111-1111-1111-111111111111`,
    webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/${id}`,
  };
}

class FakeCdpSession {
  constructor(opts) {
    this.opts = opts;
    this.calls = [];
    this.closed = false;
    this.worldId = 42;
    this.probeValue = { mounted: true, installed: true, bridge: true };
  }
  async open() { return this; }
  async send(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: ++this.worldId };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' };
    if (method === 'Runtime.evaluate' && params.returnByValue) {
      const val = typeof this.probeValue === 'function' ? this.probeValue(this.calls) : this.probeValue;
      return { result: { value: val } };
    }
    return {};
  }
  close() { this.closed = true; }
}

test('isTrustedHubTarget 校验预期 Hub 端口与 2.33+ 跨端口多窗口/启动页/设置页，严格拒绝第三方本地服务与非信任页面', () => {
  assert.equal(isTrustedHubTarget(mockTarget('a', 54321, 53150), 54321, 53150), true);
  // Antigravity 2.33+ 中 language_server 的 HTTPS Hub 与 RPC 端口相邻（如 50066 vs 50067）
  assert.equal(isTrustedHubTarget(mockTarget('a', 54321, 50066), 54321, 50067), true);
  // 重启后 LS RPC (53494) 与 Electron CDP (57951) / HTTPS Hub (57953) 相隔数千端口，Hub 与 CDP 相邻仍应放行
  assert.equal(isTrustedHubTarget(mockTarget('a', 57951, 57953), 57951, 53494), true);

  // 三者端口均远离（如 CDP 58208、LS 53494、Hub 65075）：兼容带连字符、下划线或中文工作区名的 Antigravity 标题
  assert.equal(
    isTrustedHubTarget({ ...mockTarget('a', 58208, 65075), title: 'Workspace - Antigravity' }, 58208, 53494),
    true,
  );
  assert.equal(
    isTrustedHubTarget({ ...mockTarget('a', 58208, 65075), title: 'my_project_Antigravity' }, 58208, 53494),
    true,
  );
  assert.equal(
    isTrustedHubTarget({ ...mockTarget('a', 58208, 65075), title: '思想型电台—Antigravity' }, 58208, 53494),
    true,
  );

  // 空白新标签 / 水合前瞬态 URL 标题 / 启动欢迎页 / 设置页 / 自定义页（含中文汉化标题）均应准确识别
  assert.equal(
    isTrustedHubTarget({ ...mockTarget('a', 58208, 65075), url: 'https://127.0.0.1:65075/', title: '' }, 58208, 53494),
    true,
  );
  assert.equal(
    isTrustedHubTarget({ ...mockTarget('a', 58208, 65075), title: '127.0.0.1:65075/c/11111111-1111-1111-1111-111111111111' }, 58208, 53494),
    true,
  );
  assert.equal(
    isTrustedHubTarget({ ...mockTarget('a', 58208, 65075), url: 'https://127.0.0.1:65075/settings', title: 'Settings' }, 58208, 53494),
    true,
  );
  assert.equal(
    isTrustedHubTarget({ ...mockTarget('a', 58208, 65075), url: 'https://127.0.0.1:65075/customizations', title: '自定义' }, 58208, 53494),
    true,
  );
  assert.equal(
    isTrustedHubTarget({
      ...mockTarget('a', 58208, 65075),
      url: 'https://127.0.0.1:65075/c/11111111-1111-1111-1111-111111111111?project=6cf307a7-ae19-4f03-a0f5-899f6e700ad9',
      title: 'Custom Localized Chat Title',
    }, 58208, 53494),
    true,
  );

  // 已验证同源多窗口：在同一 CDP 实例下共享 trustedOrigins 的第二窗口无条件放行
  assert.equal(
    isTrustedHubTarget(
      { ...mockTarget('b', 58208, 65075), url: 'https://127.0.0.1:65075/unknown-subview', title: 'Subview' },
      58208,
      53494,
      { trustedOrigins: new Set(['https://127.0.0.1:65075']) },
    ),
    true,
  );

  // 严格拒绝非 HTTPS 相邻端口、无宿主特征的陌生高端口应用、常见开发低端口（即便空标题或带标题）、远程页面与 iframe
  assert.equal(isTrustedHubTarget({ ...mockTarget('a', 54321, 50066), url: 'http://127.0.0.1:50066/c/11111111-1111-1111-1111-111111111111' }, 54321, 50067), false);
  assert.equal(isTrustedHubTarget({ ...mockTarget('a', 51000, 61234), title: 'My Local App' }, 51000, 53494), false);
  assert.equal(isTrustedHubTarget({ ...mockTarget('a', 51000, 61234), url: 'https://127.0.0.1:61234/dashboard', title: '' }, 51000, 53494), false);
  assert.equal(isTrustedHubTarget({ ...mockTarget('a', 54321, 8080), title: 'Antigravity Mock' }, 54321, 53150), false);
  assert.equal(isTrustedHubTarget({ ...mockTarget('a', 54321, 8443), title: 'Antigravity Mock' }, 54321, 53150), false);
  assert.equal(isTrustedHubTarget({ ...mockTarget('a', 54321, 8443), url: 'https://127.0.0.1:8443/', title: '' }, 54321, 53150), false);
  assert.equal(isTrustedHubTarget(mockTarget('a', 54321, 8080), 54321, 53150), false);
  assert.equal(isTrustedHubTarget({ ...mockTarget(), url: 'https://github.com/a/b' }, 54321, null), false);
  assert.equal(isTrustedHubTarget({ ...mockTarget(), type: 'iframe' }, 54321, null), false);
});

test('discoverHubTargets 支持多窗口同源传播，且遇到过期端口文件返回 stale_port 诊断码', async (t) => {
  const staleDir = await mkdtemp(join(tmpdir(), 'tm-cdp-stale-'));
  const liveDir = await mkdtemp(join(tmpdir(), 'tm-cdp-live-'));
  t.after(async () => {
    await rm(staleDir, { recursive: true, force: true });
    await rm(liveDir, { recursive: true, force: true });
  });

  await writeFile(join(staleDir, 'DevToolsActivePort'), '1\n/devtools/browser/fake\n', 'utf8');
  await assert.rejects(() => discoverHubTargets([staleDir]), (err) => err.diagCode === 'stale_port');

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const port = server.address().port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        // 窗口 2（排在前面）：某自定义子路由且标题不含 Antigravity，但与窗口 1 同源
        {
          type: 'page',
          title: 'Custom View',
          url: 'https://127.0.0.1:64123/custom-panel',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/win2`,
        },
        // 窗口 1：标准工作区窗口
        {
          type: 'page',
          title: 'Repo - Antigravity',
          url: 'https://127.0.0.1:64123/c/11111111-1111-1111-1111-111111111111',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/win1`,
        },
        // 陌生第三方本地服务（异源且无宿主标识，必须被过滤）
        {
          type: 'page',
          title: 'Other App',
          url: 'https://127.0.0.1:64999/',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/other`,
        },
      ]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  const cdpPort = server.address().port;
  await writeFile(join(liveDir, 'DevToolsActivePort'), `${cdpPort}\n/devtools/browser/live\n`, 'utf8');

  const res = await discoverHubTargets([staleDir, liveDir], { expectedHubPort: 51200 });
  assert.equal(res.port, cdpPort);
  assert.equal(res.targets.length, 2);
  assert.deepEqual(res.targets.map((x) => x.title), ['Custom View', 'Repo - Antigravity']);
});

test('validateBridgePayload 仅允许白名单消息类型并严格验证 UUID', () => {
  assert.ok(validateBridgePayload(JSON.stringify({ id: 1, type: 'snapshot', input: { conversationId: null } })));
  assert.equal(validateBridgePayload(JSON.stringify({ id: 1, type: 'snapshot', input: { conversationId: 'bad-id' } })), null);
  assert.equal(validateBridgePayload(JSON.stringify({ id: 1, type: 'diag', input: { mounted: true } })), null);
});

test('CdpInlineBridge 支持异步端口解析、复用存活隔离世界并兼容 Chromium 导航事件时序', async () => {
  const sessions = [];
  let resolveSlow;
  let currentTarget = { ...mockTarget('p1', 54321, 63210), title: 'Main - Antigravity' };

  const bridge = new CdpInlineBridge({
    profileCandidates: ['/none'],
    widgetCode: 'window.__agTokenMeterMounted=true;',
    getExpectedHubPort: async () => 53150,
    getSnapshot: () => new Promise((r) => { resolveSlow = r; }),
    getPrefs: async () => ({ language: 'zh-CN' }),
    setPrefs: async (p) => p,
    discover: async (_cands, opts) => {
      const ok = isTrustedHubTarget(currentTarget, 54321, opts.expectedHubPort, { trustedOrigins: opts.trustedOrigins });
      return { port: 54321, targets: ok ? [currentTarget] : [] };
    },
    createSession: (_url, opts) => {
      const s = new FakeCdpSession(opts);
      sessions.push(s);
      return s;
    },
  });

  await bridge.tick();
  assert.equal(bridge.status.state, 'mounted');
  const s = sessions[0];
  const addBindingCall = s.calls.find((c) => c.method === 'Runtime.addBinding');
  assert.equal(addBindingCall.params.executionContextName, 'AntigravityTokenMeterWorld');

  // 验证单窗口切换到无 Antigravity 标题后缀的子视图时，依靠已记录的 trustedOrigins 绝不误摘除会话
  currentTarget = { ...currentTarget, url: 'https://127.0.0.1:63210/custom-view', title: 'Custom Settings' };
  await bridge.tick();
  assert.equal(bridge.sessions.size, 1);
  assert.equal(s.closed, false);

  // 验证探针发现脚本未安装时复用现有 worldContextId 重新注入，不重复调用 Page.createIsolatedWorld
  const worldsBefore = s.calls.filter((c) => c.method === 'Page.createIsolatedWorld').length;
  let probedCount = 0;
  s.probeValue = () => {
    probedCount++;
    return probedCount === 1
      ? { mounted: false, installed: false, bridge: true }
      : { mounted: true, installed: true, bridge: true };
  };
  await bridge.tick();
  const worldsAfter = s.calls.filter((c) => c.method === 'Page.createIsolatedWorld').length;
  assert.equal(worldsAfter, worldsBefore);
  assert.equal(bridge.status.state, 'mounted');

  // 发起一个慢请求，但在返回前页面发生顶层导航（docEpoch 递增），旧回包必须丢弃
  const ctxId = s.worldId;
  const evalBefore = s.calls.filter((c) => c.method === 'Runtime.evaluate').length;
  const reqPromise = bridge._handleEvent(s, {
    method: 'Runtime.bindingCalled',
    params: { name: bridge.bindingName, executionContextId: ctxId, payload: JSON.stringify({ id: 1, type: 'snapshot', input: {} }) },
  });
  await new Promise((r) => setImmediate(r));
  await bridge._handleEvent(s, { method: 'Page.frameNavigated', params: { frame: { id: 'main-frame' } } });
  resolveSlow({ connected: true });
  await reqPromise;
  const evalAfter = s.calls.filter((c) => c.method === 'Runtime.evaluate').length;
  assert.equal(evalAfter, evalBefore);

  // 完成上述第一次导航的新上下文创建（666）
  await bridge._handleEvent(s, {
    method: 'Runtime.executionContextCreated',
    params: {
      context: {
        id: 666,
        name: 'AntigravityTokenMeterWorld',
        auxData: { isDefault: false, frameId: 'main-frame' },
      },
    },
  });
  assert.equal(s.worldContextId, 666);

  // 验证时序一：executionContextsCleared -> executionContextCreated(777) -> frameNavigated 不会误清空新上下文 777
  const capturedInputs = [];
  bridge.getSnapshot = async (inp) => {
    capturedInputs.push(inp);
    return { connected: true };
  };
  await bridge._handleEvent(s, { method: 'Runtime.executionContextsCleared', params: {} });
  await bridge._handleEvent(s, {
    method: 'Runtime.executionContextCreated',
    params: {
      context: {
        id: 777,
        name: 'AntigravityTokenMeterWorld',
        auxData: { isDefault: false, frameId: 'main-frame' },
      },
    },
  });
  await bridge._handleEvent(s, { method: 'Page.frameNavigated', params: { frame: { id: 'main-frame' } } });
  assert.equal(s.worldContextId, 777);

  await bridge._handleEvent(s, {
    method: 'Runtime.bindingCalled',
    params: { name: bridge.bindingName, executionContextId: 777, payload: JSON.stringify({ id: 2, type: 'snapshot', input: { conversationId: null } }) },
  });
  assert.equal(capturedInputs.length, 1);
  assert.deepEqual(capturedInputs[0], { conversationId: null, allowFallback: false });

  // 验证连续多次混合时序导航（回归测试）：
  // 第 A 次按 frameNavigated -> executionContextsCleared -> executionContextCreated(888) 完成，
  // 紧接着第 B 次导航且 frameNavigated 先于 executionContextsCleared 到达时，必须立即清空旧上下文 888，绝不残留！
  await bridge._handleEvent(s, { method: 'Page.frameNavigated', params: { frame: { id: 'main-frame' } } });
  assert.equal(s.worldContextId, null);
  await bridge._handleEvent(s, { method: 'Runtime.executionContextsCleared', params: {} });
  await bridge._handleEvent(s, {
    method: 'Runtime.executionContextCreated',
    params: {
      context: {
        id: 888,
        name: 'AntigravityTokenMeterWorld',
        auxData: { isDefault: false, frameId: 'main-frame' },
      },
    },
  });
  assert.equal(s.worldContextId, 888);

  // 第 B 次导航：frameNavigated 先到达，此时 888 属于上一页面，必须被清零且拒绝旧上下文的 bindingCalled
  await bridge._handleEvent(s, { method: 'Page.frameNavigated', params: { frame: { id: 'main-frame' } } });
  assert.equal(s.worldContextId, null);
  await bridge._handleEvent(s, {
    method: 'Runtime.bindingCalled',
    params: { name: bridge.bindingName, executionContextId: 888, payload: JSON.stringify({ id: 3, type: 'snapshot', input: { conversationId: null } }) },
  });
  assert.equal(capturedInputs.length, 1);

  await bridge.stop();
  assert.equal(s.closed, true);
});

test('buildInjectableBundle 桥接层在瞬时重连时保留同会话与全局快照防闪烁，切换新会话绝不串旧对话数据', async () => {
  const bindingName = '__agTokenMeterCallV2_testtoken';
  const bundle = buildInjectableBundle({
    widgetCode: '',
    bindingName,
    ownerToken: 'testtoken',
  });

  let nextReply = null;
  const sandbox = {
    window: null,
    globalThis: null,
    setTimeout,
    clearTimeout,
    Date,
    Map,
    Promise,
    JSON,
  };
  sandbox.window = sandbox;
  sandbox.window.top = sandbox.window;
  sandbox.globalThis = sandbox;
  sandbox[bindingName] = (raw) => {
    const parsed = JSON.parse(raw);
    setImmediate(() => {
      sandbox.__agTokenMeterBridge.resolve(parsed.id, nextReply);
    });
  };

  vm.runInNewContext(bundle, sandbox);

  const cidA = '11111111-1111-1111-1111-111111111111';
  const cidB = '22222222-2222-2222-2222-222222222222';
  nextReply = {
    connected: true,
    conversationUnavailable: false,
    conversation: { model: 'Gemini 4 Carbon', tps: 128.5 },
    usage: { monthTokens: 500000 },
    quotas: [{ title: 'Gemini Models', remainingFraction: 0.8 }],
  };
  const first = await sandbox.__agTokenMeterApi.getSnapshot(cidA);
  assert.equal(first.connected, true);
  assert.equal(first.conversation.tps, 128.5);

  // 同一会话偶发一次桥接失败：平滑复用上次快照防“--”闪烁
  nextReply = { connected: false, error: 'request_failed' };
  const secondSame = await sandbox.__agTokenMeterApi.getSnapshot(cidA);
  assert.equal(secondSame.connected, true);
  assert.equal(secondSame.stale, true);
  assert.equal(secondSame.conversation.tps, 128.5);
  assert.equal(secondSame.usage.monthTokens, 500000);

  // 切换到另一会话时遇到瞬时重连：保留全局额度与用量，但严禁串用旧会话 conversation
  const thirdOther = await sandbox.__agTokenMeterApi.getSnapshot(cidB);
  assert.equal(thirdOther.usage.monthTokens, 500000);
  assert.equal(thirdOther.conversation, null);
  assert.equal(thirdOther.conversationUnavailable, true);
});

test('LanguageServerClient 支持外网超时时通过本地轨迹接口完成握手，且慢请求超时不清空已确认端点', async () => {
  assert.deepEqual(parseLoopbackEndpoint('127.0.0.1:53150'), {
    protocol: null,
    hostname: '127.0.0.1',
    port: 53150,
  });

  const calls = [];
  const client = new LanguageServerClient({
    env: {
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:53150',
      ANTIGRAVITY_CSRF_TOKEN: 'csrf-secret',
    },
    rpcImpl: async ({ protocol, method }) => {
      calls.push(`${protocol}//${method}`);
      if (protocol === 'https:' && method === 'GetUserStatus') {
        const err = new Error('rpc_timeout_GetUserStatus');
        err.isTimeout = true;
        throw err;
      }
      if (protocol === 'https:' && method === 'GetAllCascadeTrajectories') {
        return { trajectorySummaries: {} };
      }
      if (protocol === 'https:' && method === 'RetrieveUserQuotaSummary') {
        const err = new Error('rpc_timeout_RetrieveUserQuotaSummary');
        err.isTimeout = true;
        throw err;
      }
      throw new Error('unexpected');
    },
  });

  assert.equal(client.configuredEndpoint?.port, 53150);
  const traj = await client.getAllTrajectories(3000);
  assert.deepEqual(traj, { trajectorySummaries: {} });
  assert.equal(client.currentEndpoint?.protocol, 'https:');
  assert.equal(client.currentEndpoint?.port, 53150);

  // 单个慢 RPC 超时不应清空已解析成功的本地端点
  await assert.rejects(() => client.retrieveUserQuotaSummary(false, 1500), /rpc_timeout_RetrieveUserQuotaSummary/);
  assert.equal(client.currentEndpoint?.port, 53150);
});

test('LanguageServerClient 对纯 HTTP localhost 毫秒级从 HTTPS 切换至 HTTP，且 127.0.0.1 拒绝时自动回退 ::1', async () => {
  const attempted = [];
  const client = new LanguageServerClient({
    env: {
      ANTIGRAVITY_LS_ADDRESS: 'localhost:52296',
      ANTIGRAVITY_CSRF_TOKEN: 'csrf-token',
    },
    rpcImpl: async ({ protocol, hostname, method }) => {
      attempted.push(`${protocol}//${hostname}/${method}`);
      if (hostname === '127.0.0.1') {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:52296');
        err.code = 'ECONNREFUSED';
        throw err;
      }
      if (hostname === '::1' && protocol === 'https:') {
        const err = new Error('write EPROTO: wrong version number');
        err.code = 'ERR_SSL_WRONG_VERSION_NUMBER';
        throw err;
      }
      if (hostname === '::1' && protocol === 'http:') {
        return { trajectorySummaries: {} };
      }
      throw new Error('unexpected');
    },
  });

  const res = await client.getAllTrajectories(3000);
  assert.deepEqual(res, { trajectorySummaries: {} });
  assert.equal(client.currentEndpoint?.hostname, '::1');
  assert.equal(client.currentEndpoint?.protocol, 'http:');
  // 127.0.0.1 ECONNREFUSED 应立即跳过同主机的剩余探测并切换 ::1；::1 上 https 协议错应立即切 http
  assert.deepEqual(attempted, [
    'https://127.0.0.1/GetUserStatus',
    'https://::1/GetUserStatus',
    'http://::1/GetUserStatus',
    'http://::1/GetAllCascadeTrajectories',
  ]);
});

test('discoverHubTargets 兼容 UTF-8 BOM 端口文件与多候选目录并发容错，并识别 2.34+ 项目/市场路由', async (t) => {
  assert.equal(
    isTrustedHubTarget({ ...mockTarget('p', 58208, 65075), url: 'https://127.0.0.1:65075/projects', title: 'Projects' }, 58208, 53494),
    true,
  );
  assert.equal(
    isTrustedHubTarget({ ...mockTarget('p', 58208, 65075), url: 'https://127.0.0.1:65075/marketplace', title: '市场' }, 58208, 53494),
    true,
  );

  const deadDir = await mkdtemp(join(tmpdir(), 'tm-cdp-dead-'));
  const bomDir = await mkdtemp(join(tmpdir(), 'tm-cdp-bom-'));
  t.after(async () => {
    await rm(deadDir, { recursive: true, force: true });
    await rm(bomDir, { recursive: true, force: true });
  });

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const port = server.address().port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        {
          type: 'page',
          title: 'Antigravity',
          url: 'https://127.0.0.1:64321/',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/main`,
        },
      ]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  await writeFile(join(deadDir, 'DevToolsActivePort'), '1\n/devtools/browser/dead\n', 'utf8');
  await writeFile(join(bomDir, 'DevToolsActivePort'), `\uFEFF${server.address().port}\n/devtools/browser/live\n`, 'utf8');

  const discovered = await discoverHubTargets([deadDir, bomDir], { expectedHubPort: 51000 });
  assert.equal(discovered.port, server.address().port);
  assert.equal(discovered.targets.length, 1);
});

test('plugin.json 与 sidecar.json 严格符合 Antigravity 2.33+/2.34+ 官方清单规范', async () => {
  const pluginJson = JSON.parse(await readFile(join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
  assert.equal(pluginJson.$schema, 'https://antigravity.google/schemas/v1/plugin.json');
  assert.equal(pluginJson.name, 'antigravity-token-meter');
  assert.equal(typeof pluginJson.displayName, 'string');
  assert.ok(pluginJson.displayName.length > 0);
  assert.equal(Object.hasOwn(pluginJson, 'display_name'), false);
  assert.equal(pluginJson.logo, 'assets/logo.svg');

  const sidecarJson = JSON.parse(await readFile(join(METER_DIR, 'sidecar.json'), 'utf8'));
  assert.equal(sidecarJson.command, 'node');
  assert.deepEqual(sidecarJson.args, ['main.mjs']);
  assert.equal(sidecarJson.restart_policy, 'always');
  assert.equal(sidecarJson.has_web_ui, true);
  assert.equal(sidecarJson.agent_permissions?.allows_user_interactions, false);
  assert.equal(sidecarJson.ui_config?.views?.[0]?.entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');
});

async function runMainProcess(env, { waitForExit = true, timeoutMs = 8000 } = {}) {
  const child = spawn(process.execPath, [join(METER_DIR, 'main.mjs')], {
    cwd: METER_DIR,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

  if (!waitForExit) {
    return {
      child,
      getOutput: () => ({ stdout, stderr }),
    };
  }

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`main.mjs timed out: stderr=${stderr}`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return { exitCode, stdout, stderr };
}

test('main.mjs 启动诊断：缺失 sidecar_sdk 或必需环境变量时原子落盘错误状态、脱敏且不覆盖存活主实例', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tm-boot-diag-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const dataDir = join(root, '.gemini', 'antigravity', 'sidecar_data', 'antigravity-token-meter', 'meter', 'data');
  const statusFile = join(dataDir, 'integration-status.json');
  const secretToken = 'super-secret-csrf-987654321';

  // 1. 缺失 sidecar_sdk：应退出非 0 且落盘 sdk_not_found
  const rSdk = await runMainProcess({
    USERPROFILE: root,
    HOME: root,
    APPDATA: join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'AppData', 'Local'),
    ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
    ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:59999',
    ANTIGRAVITY_CSRF_TOKEN: secretToken,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
  });
  assert.notEqual(rSdk.exitCode, 0);
  assert.match(rSdk.stderr, /sdk_not_found/);
  const sdkStatus = JSON.parse(await readFile(statusFile, 'utf8'));
  assert.equal(sdkStatus.state, 'error');
  assert.equal(sdkStatus.code, 'sdk_not_found');
  assert.equal(sdkStatus.stage, 'sdk_load');
  assert.equal(sdkStatus.errorMessage.includes(secretToken), false);

  // 2. 缺失 ANTIGRAVITY_LS_ADDRESS：应落盘 missing_env
  const rEnv = await runMainProcess({
    USERPROFILE: root,
    HOME: root,
    APPDATA: join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'AppData', 'Local'),
    ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
  });
  assert.notEqual(rEnv.exitCode, 0);
  const envStatus = JSON.parse(await readFile(statusFile, 'utf8'));
  assert.equal(envStatus.state, 'error');
  assert.equal(envStatus.code, 'missing_env');

  // 3. 若已有存活健康主实例状态文件，异常子进程绝不覆写破坏
  await writeFile(
    statusFile,
    JSON.stringify({
      state: 'mounted',
      code: 'mounted',
      windows: 1,
      pid: process.pid,
      checkedAt: new Date().toISOString(),
    }),
    'utf8'
  );
  await runMainProcess({
    USERPROFILE: root,
    HOME: root,
    APPDATA: join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'AppData', 'Local'),
    ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
  });
  const preserved = JSON.parse(await readFile(statusFile, 'utf8'));
  assert.equal(preserved.state, 'mounted');
  assert.equal(preserved.pid, process.pid);
});

test('main.mjs 零配置端到端启动：含中文空格路径且无 settings.json 与 --import 时自动寻址 sidecar_sdk 并默认启用内嵌探测', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tm-e2e-中文 路径-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const appDataDir = join(root, '.gemini', 'antigravity');
  const sdkDir = join(appDataDir, 'lib', 'node_modules', 'sidecar_sdk');
  const dataDir = join(appDataDir, 'sidecar_data', 'antigravity-token-meter', 'meter', 'data');
  await mkdir(sdkDir, { recursive: true });
  // 写入与官方 sidecar_sdk 契约一致的轻量测试桩（不依赖外部包）
  await writeFile(
    join(sdkDir, 'index.mjs'),
    `import { createServer } from 'node:http';
export class Response {
  constructor(body, { contentType = 'text/plain', status = 200, headers } = {}) {
    this.body = body; this.contentType = contentType; this.status = status; this.headers = headers;
  }
}
export class SidecarApp {
  #port; #apis = new Map(); #pages = new Map();
  constructor() {
    if (!process.env.ANTIGRAVITY_LS_ADDRESS || !process.env.ANTIGRAVITY_CSRF_TOKEN || !process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
      throw new Error('Missing required env');
    }
    this.#port = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT, 10);
  }
  page(p, h) { this.#pages.set(p, h); }
  api(p, h, m = 'POST') {
    if (!this.#apis.has(p)) this.#apis.set(p, new Map());
    this.#apis.get(p).set(m.toUpperCase(), h);
  }
  run() {
    const server = createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (this.#apis.has(u.pathname) && this.#apis.get(u.pathname).has(req.method)) {
        const result = await this.#apis.get(u.pathname).get(req.method)({});
        if (result instanceof Response) {
          res.writeHead(result.status || 200, { 'Content-Type': result.contentType });
          res.end(result.body);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(404); res.end('Not found');
    });
    return new Promise((resolve) => {
      server.listen(this.#port, '127.0.0.1', () => {
        console.log('[sidecar] listening on 127.0.0.1:' + server.address().port);
        resolve(server);
      });
    });
  }
}
`,
    'utf8'
  );

  // 启动模拟本地 LS HTTP 服务器
  const lsServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.endsWith('/GetUserStatus')) {
      res.end(JSON.stringify({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } }));
    } else if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      res.end(JSON.stringify({ trajectorySummaries: {} }));
    } else {
      res.end('{}');
    }
  });
  await new Promise((r) => lsServer.listen(0, '127.0.0.1', r));
  t.after(() => lsServer.close());

  const { child, getOutput } = await runMainProcess(
    {
      USERPROFILE: root,
      HOME: root,
      APPDATA: join(root, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(root, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(root, '.config'),
      XDG_DATA_HOME: join(root, '.local', 'share'),
      ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
      ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${lsServer.address().port}`,
      ANTIGRAVITY_CSRF_TOKEN: 'e2e-csrf-token',
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
    },
    { waitForExit: false }
  );
  t.after(() => {
    try { child.kill('SIGTERM'); } catch {}
  });

  // 等待监听日志输出真实端口
  let webPort = null;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const out = getOutput();
    const m = out.stdout.match(/listening on 127\.0\.0\.1:(\d+)/);
    if (m) {
      webPort = Number(m[1]);
      break;
    }
    if (child.exitCode !== null) {
      assert.fail(`main.mjs exited unexpectedly (${child.exitCode}): ${out.stderr}`);
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.ok(webPort && webPort > 0, `未检测到监听端口: ${JSON.stringify(getOutput())}`);

  // 调用 /api/snapshot 验证零配置开箱正常响应且默认开启内嵌探测（而非 inline_disabled）
  const snap = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${webPort}/api/snapshot`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    });
    req.on('error', reject);
  });
  assert.equal(snap.status, 200);
  assert.equal(snap.json.connected, true);
  assert.notEqual(snap.json.integration?.code, 'inline_disabled');

  // 等待 integration-status.json 落盘并核验其进入正常探测态（无 DevToolsActivePort 时为 no_active_port 或 starting）
  const statusFile = join(dataDir, 'integration-status.json');
  let diskStatus = null;
  for (let i = 0; i < 20; i++) {
    try {
      diskStatus = JSON.parse(await readFile(statusFile, 'utf8'));
      if (diskStatus && diskStatus.code === 'no_active_port') break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(diskStatus, '应自动创建并写入 integration-status.json');
  assert.notEqual(diskStatus.code, 'inline_disabled');
  assert.ok(['starting', 'no_active_port'].includes(diskStatus.code), `unexpected code: ${diskStatus.code}`);
});
