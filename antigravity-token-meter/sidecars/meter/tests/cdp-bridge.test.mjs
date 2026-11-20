import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CdpInlineBridge,
  buildInjectableBundle,
  discoverHubTargets,
  isTrustedHubTarget,
  validateBridgePayload,
} from '../src/cdp-bridge.mjs';
import { LanguageServerClient, parseLoopbackEndpoint } from '../src/ls-client.mjs';

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
