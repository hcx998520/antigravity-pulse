import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInlineWidgetScript } from '../src/ui/inline-bar.mjs';

/**
 * 极简只读 DOM 沙箱，用于在纯 Node.js 环境验证 buildInlineWidgetScript() 的挂载与分格悬停行为。
 */
function createDomEnv(snapshot) {
  const docListeners = new Map();
  const winListeners = new Map();

  class FakeClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...cls) { cls.forEach((c) => this.set.add(c)); }
    remove(...cls) { cls.forEach((c) => this.set.delete(c)); }
    toggle(c, force) {
      if (force === undefined) force = !this.set.has(c);
      if (force) this.set.add(c);
      else this.set.delete(c);
      return force;
    }
    contains(c) { return this.set.has(c); }
  }

  class FakeElement {
    constructor(tag = 'div', ownerDoc = null) {
      this.tagName = tag.toUpperCase();
      this.ownerDocument = ownerDoc;
      this.attributes = new Map();
      this.style = {};
      this.children = [];
      this.parentElement = null;
      this.classList = new FakeClassList(this);
      this.listeners = new Map();
      this._innerHTML = '';
      this._textContent = '';
      this.id = '';
      this.shadowRootMock = null;
    }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.classList = new FakeClassList(this), String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
    }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === doc.body || cur === doc.documentElement) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    get nextElementSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx >= 0 ? (this.parentElement.children[idx + 1] || null) : null;
    }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    get firstChild() { return this.children[0] || null; }
    get offsetWidth() { return 308; }
    get offsetHeight() { return 210; }
    appendChild(child) {
      if (child.parentElement) {
        const i = child.parentElement.children.indexOf(child);
        if (i >= 0) child.parentElement.children.splice(i, 1);
      }
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    insertBefore(child, ref) {
      if (!ref) return this.appendChild(child);
      if (child.parentElement) {
        const i = child.parentElement.children.indexOf(child);
        if (i >= 0) child.parentElement.children.splice(i, 1);
      }
      const idx = this.children.indexOf(ref);
      child.parentElement = this;
      if (idx >= 0) this.children.splice(idx, 0, child);
      else this.children.push(child);
      return child;
    }
    remove() {
      if (!this.parentElement) return;
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) this.parentElement.children.splice(i, 1);
      this.parentElement = null;
    }
    attachShadow() {
      const root = new FakeElement('shadow-root', this.ownerDocument);
      root.getElementById = (id) => root.querySelector(`#${id}`);
      this.shadowRootMock = root;
      return root;
    }
    set innerHTML(html) {
      this._innerHTML = String(html);
      this.children = [];
      // 对包含 tm-wrap / tm-chip / tm-popover 的关键测试节点生成轻量 DOM 树
      if (this._innerHTML.includes('id="tm-chips"')) {
        const wrap = new FakeElement('div', doc); wrap.setAttribute('id', 'tm-wrap');
        const chips = new FakeElement('div', doc); chips.setAttribute('id', 'tm-chips');
        const pop = new FakeElement('div', doc); pop.setAttribute('id', 'tm-popover');
        wrap.appendChild(chips);
        wrap.appendChild(pop);
        this.appendChild(wrap);
        return;
      }
      const chipMatches = [...this._innerHTML.matchAll(/data-tm-chip="([^"]+)"/g)];
      if (chipMatches.length > 0 && !this._innerHTML.includes('class="tm-head"')) {
        for (const m of chipMatches) {
          const btn = new FakeElement('button', doc);
          btn.setAttribute('data-tm-chip', m[1]);
          btn.setAttribute('data-tm-trigger', '1');
          btn.getBoundingClientRect = () => ({ left: 260, top: 680, right: 340, bottom: 704, width: 80, height: 24 });
          this.appendChild(btn);
        }
      }
    }
    get innerHTML() { return this._innerHTML; }
    set textContent(v) { this._textContent = String(v); }
    get textContent() { return this._textContent; }
    addEventListener(ev, fn) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, []);
      this.listeners.get(ev).push(fn);
    }
    dispatchEvent(ev) {
      ev.target = ev.target || this;
      let cur = this;
      while (cur) {
        const list = cur.listeners.get(ev.type) || [];
        for (const fn of list) fn(ev);
        cur = cur.parentElement;
      }
    }
    closest(sel) {
      if (!sel.startsWith('[data-tm-chip]')) return null;
      let cur = this;
      while (cur) {
        if (cur.getAttribute('data-tm-chip') !== null) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    getBoundingClientRect() { return { left: 200, top: 680, right: 820, bottom: 708, width: 620, height: 28 }; }
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const ch of node.children) {
          if (matchesSelector(ch, sel)) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }

  function matchesSelector(el, sel) {
    for (const part of sel.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (part.startsWith('#') && el.id === part.slice(1)) return true;
      if (part.startsWith('.') && el.classList.contains(part.slice(1))) return true;
      if (part === '[data-tm-chip]' && el.getAttribute('data-tm-chip') !== null) return true;
      const m = part.match(/^\[([a-z0-9-]+)="([^"]+)"\]$/i);
      if (m && el.getAttribute(m[1]) === m[2]) return true;
    }
    return false;
  }

  const doc = {
    readyState: 'complete',
    documentElement: new FakeElement('html', null),
    body: new FakeElement('body', null),
    createElement: (tag) => new FakeElement(tag, doc),
    querySelectorAll: (sel) => doc.body.querySelectorAll(sel),
    querySelector: (sel) => doc.body.querySelector(sel),
    addEventListener: (ev, fn) => {
      if (!docListeners.has(ev)) docListeners.set(ev, []);
      docListeners.get(ev).push(fn);
    },
    removeEventListener: () => {},
  };
  doc.documentElement.appendChild(doc.body);

  // 构建宿主聊天框与 .agy-composer-footer 结构
  const box = new FakeElement('div', doc);
  box.setAttribute('data-testid', 'agent-input-box');
  const footer = new FakeElement('div', doc);
  footer.setAttribute('class', 'agy-composer-footer');
  footer.getBoundingClientRect = () => ({ left: 100, top: 676, right: 1060, bottom: 708, width: 960, height: 32 });
  const left = new FakeElement('div', doc);
  left.getBoundingClientRect = () => ({ left: 100, top: 676, right: 270, bottom: 708, width: 170, height: 32 });
  const right = new FakeElement('div', doc);
  right.setAttribute('data-testid', 'permissions-selector-trigger');
  right.getBoundingClientRect = () => ({ left: 890, top: 676, right: 1060, bottom: 708, width: 170, height: 32 });
  footer.appendChild(left);
  footer.appendChild(right);
  box.appendChild(footer);
  doc.body.appendChild(box);

  const win = {
    top: null,
    innerWidth: 1280,
    innerHeight: 800,
    location: { pathname: '/c/11111111-1111-1111-1111-111111111111' },
    __agTokenMeterApi: {
      getSnapshot: async () => snapshot,
      setPrefs: async (p) => Object.assign({}, snapshot.preferences, p, { version: 2 }),
    },
    addEventListener: (ev, fn) => {
      if (!winListeners.has(ev)) winListeners.set(ev, []);
      winListeners.get(ev).push(fn);
    },
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false }),
  };
  win.window = win;
  win.top = win;

  return { doc, win, box, footer, left, right };
}

test('buildInlineWidgetScript 一格一卡按需聚焦弹窗且悬停切换互不串栏', async (t) => {
  const snapshot = {
    version: '1.2.14',
    connected: true,
    preferences: {
      language: 'zh-CN',
      theme: 'swiss',
      showSpeed: true,
      showCache: true,
      showContext: true,
      showQuota: true,
      showToday: true,
      showMonth: true,
      showCost: false,
      version: 1,
    },
    conversation: {
      model: 'Gemini 4 Neon (XHigh)',
      running: true,
      latestTps: 134.4,
      tps: 149.7,
      ttftSeconds: 4.43,
      streamingSeconds: 68.4,
      measuredRequests: 28,
      requests: 30,
      cacheHitRate: 0.87,
      thinkingRatio: 0.21,
      costUsd: 12.34,
      pricing: { inputPer1M: 3, cacheReadPer1M: 0.15, outputPer1M: 15 },
      lastRequestTime: new Date().toISOString(),
      tokens: { total: 58000000, inputAll: 57360000, uncachedInput: 7350000, cacheRead: 50010000, output: 627900, responseOutput: 498600, thinkingOutput: 129300 },
      context: { usedTokens: 167900, maxTokens: 512000, remainingTokens: 344100, usedFraction: 0.328, estimatedTurnsLeft: 9 },
      sparkline: [{ tps: 120 }, { tps: 134.4 }],
    },
    quotas: [
      {
        title: 'Gemini Models',
        fiveHour: { remainingFraction: 0.82, resetTime: new Date(Date.now() + 3600000).toISOString(), pacing: { timeRemainingFraction: 0.72, status: 'ok' } },
        weekly: { remainingFraction: 0.92, resetTime: new Date(Date.now() + 5 * 86400000).toISOString(), pacing: { timeRemainingFraction: 0.75, status: 'ok' } },
      },
    ],
    quotaPair: { title: 'Gemini Models', fiveHourFraction: 0.82, weeklyFraction: 0.92 },
    usage: {
      todayDate: '2026-11-19',
      monthKey: '2026-11',
      todayTokens: 288800000,
      todayInput: 27340000,
      todayCacheRead: 257350000,
      todayOutput: 3260000,
      todayRequests: 1646,
      todayByModel: [{ model: 'Gemini 4 Neon (XHigh)', totalTokens: 137400000 }],
      weekTokens: 847150000,
      monthTokens: 2680000000,
      monthInput: 240000000,
      monthCacheRead: 2380000000,
      monthOutput: 55000000,
      monthRequests: 20498,
      activeDays: 47,
      totalRequests: 28050,
      peakDay: { date: '2026-11-14', total: 612000000 },
      currentStreak: 12,
      longestStreak: 18,
      totalTokens: 3370000000,
      days: [
        { date: '2026-11-14', total: 612000000, byModel: { 'Gemini 4 Argon (High)': 400000000, 'Gemini 4 Neon (XHigh)': 212000000 } },
        { date: '2026-11-19', total: 288800000, byModel: { 'Gemini 4 Neon (XHigh)': 188800000, 'Gemini 4 Argon (High)': 100000000 } },
      ],
      modelRank: [
        { model: 'Gemini 4 Argon (High)', totalTokens: 1100000000, outputTokens: 15000000, avgTps: 150.2, requests: 9063 },
        { model: 'Gemini 4 Neon (XHigh)', totalTokens: 540000000, outputTokens: 8000000, avgTps: 146.0, requests: 826 },
      ],
    },
  };

  const { doc, win, footer } = createDomEnv(snapshot);
  t.after(() => {
    try { win.__agTokenMeterDispose?.(); } catch {}
  });
  let resizeCb = null;
  const code = buildInlineWidgetScript();
  const fn = new Function('window', 'document', 'location', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', code);
  fn(
    win,
    doc,
    win.location,
    () => ({ display: 'flex', visibility: 'visible', opacity: '1', flexDirection: 'row', backgroundColor: '#ffffff' }),
    class { observe() {} disconnect() {} },
    class { constructor(cb) { resizeCb = cb; } observe() {} disconnect() {} }
  );

  // 等待首次异步快照加载完成
  await new Promise((r) => setTimeout(r, 30));

  const host = doc.querySelector('#ag-token-meter-host');
  assert.ok(host, 'host element should mount into composer footer');
  const shadow = host.shadowRootMock;
  const pop = shadow.getElementById('tm-popover');

  const expectByChip = {
    speed: { must: ['生成速率', '134.4', '会话均速', 'tm-spark-svg', 'tm-sp-node', 'tm-spark-tip'], forbid: ['模型额度', '今日模型分布', '近 14 天趋势', '~$12.34'] },
    cache: { must: ['缓存效率', '87%', '未缓存输入'], forbid: ['会话均速', '模型额度', '近 14 天趋势'] },
    context: { must: ['上下文窗口', '33%', '约余 9 轮', 'linear-gradient'], forbid: ['会话均速', '模型额度', '今日模型分布'] },
    quota: { must: ['模型额度', 'Gemini Models', '82%', '92%', '竖线为时间基准'], forbid: ['会话均速', '上下文空间充裕', '近 14 天趋势'] },
    today: { must: ['今日消耗', '288.80M', '今日模型分布'], forbid: ['模型额度', '近 14 天趋势', '会话均速', '~$'] },
    month: { must: ['本月消耗', '2.68B', '近 14 天趋势', 'tm-trend-svg', 'tm-trend-hit', 'tm-trend-tip', 'tm-trend-readout'], forbid: ['模型额度', '今日模型分布', '会话均速', '<title>2026-', '~$'] },
  };

  for (const [chipKey, rule] of Object.entries(expectByChip)) {
    const chip = shadow.querySelector(`[data-tm-chip="${chipKey}"]`);
    assert.ok(chip, `chip ${chipKey} should exist`);
    chip.dispatchEvent({ type: 'mouseover' });
    assert.equal(pop.classList.contains('open'), true, `${chipKey} hover should open popover`);
    assert.equal(chip.classList.contains('active'), true, `${chipKey} should gain active class`);
    for (const s of rule.must) {
      assert.ok(pop.innerHTML.includes(s), `${chipKey} popover must include "${s}"`);
    }
    for (const s of rule.forbid) {
      assert.equal(pop.innerHTML.includes(s), false, `${chipKey} popover must NOT include unrelated section "${s}"`);
    }
  }

  // 点击同一格锁定，再点击解锁关闭；点击另一格切换锁定目标
  const quotaChip = shadow.querySelector('[data-tm-chip="quota"]');
  quotaChip.dispatchEvent({ type: 'click' });
  assert.equal(pop.classList.contains('open'), true);
  assert.ok(pop.innerHTML.includes('Gemini Models'));
  quotaChip.dispatchEvent({ type: 'click' });
  assert.equal(pop.classList.contains('open'), false);

  // 确认代码包含 ZCode 风格使用统计弹窗（5 栏 KPI、52 周热力图、每日平滑趋势图、Donut 圆环图与实时互动浮窗/准星）
  assert.ok(
    code.includes('tm-z-kpis') &&
    code.includes('tm-z-donut-svg') &&
    code.includes('buildMonotoneSplinePath') &&
    code.includes('tm-z-tip') &&
    code.includes('tm-zcum-xhair') &&
    code.includes('tm-ztrend-xhair')
  );

  // 验证缩窄聊天框宽度时绝不掉到下方，依次平滑切入 compact 与 tight(+N) 收纳档位
  assert.equal(host.getAttribute('data-placement'), 'inline-footer');
  assert.equal(host.getAttribute('data-density'), 'full');

  // 缩窄到中等聊天框（730px，可用空间 ~372px -> 命中 compact 档，6 项全保留不掉行）
  footer.getBoundingClientRect = () => ({ left: 100, top: 676, right: 830, bottom: 708, width: 730, height: 32 });
  resizeCb?.();
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(host.getAttribute('data-placement'), 'inline-footer');
  assert.equal(host.getAttribute('data-density'), 'compact');
  assert.equal(shadow.querySelectorAll('[data-tm-chip]').length, 6);

  // 继续缩窄到窄分屏（560px，可用空间 ~202px -> 命中 tight 档，核心项 + "+N" 溢出胶囊）
  footer.getBoundingClientRect = () => ({ left: 100, top: 676, right: 660, bottom: 708, width: 560, height: 32 });
  resizeCb?.();
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(host.getAttribute('data-placement'), 'inline-footer');
  assert.equal(host.getAttribute('data-density'), 'tight');
  const moreChip = shadow.querySelector('[data-tm-chip="more"]');
  assert.ok(moreChip, 'narrow split should display +N overflow chip');
  moreChip.dispatchEvent({ type: 'mouseover' });
  assert.ok(pop.innerHTML.includes('更多指标'));

  win.__agTokenMeterDispose();
});

test('英文模式浮卡排版防溢出：进度条短标 5h/7d 无重叠、无多余空格且底栏宽窄自适应', async (t) => {
  const snapshot = {
    version: '1.2.14',
    connected: true,
    preferences: {
      language: 'en',
      theme: 'swiss',
      showSpeed: true,
      showCache: true,
      showContext: true,
      showQuota: true,
      showToday: true,
      showMonth: true,
      version: 2,
    },
    conversation: {
      model: 'Gemini 4 Neon',
      running: false,
      latestTps: 142.0,
      tps: 138.5,
      ttftSeconds: 1.9,
      streamingSeconds: 20.5,
      measuredRequests: 10,
      requests: 10,
      cacheHitRate: 0.89,
      thinkingRatio: 0.15,
      lastRequestTime: new Date().toISOString(),
      tokens: { total: 1000000, inputAll: 950000, uncachedInput: 100000, cacheRead: 850000, output: 50000, responseOutput: 40000, thinkingOutput: 10000 },
      context: { usedTokens: 150000, maxTokens: 512000, remainingTokens: 362000, usedFraction: 0.293, estimatedTurnsLeft: 9 },
      sparkline: [{ tps: 130 }, { tps: 142 }],
    },
    quotas: [
      {
        title: 'Gemini Models',
        fiveHour: { remainingFraction: 0.95, resetTime: new Date(Date.now() + 3600000).toISOString(), pacing: { timeRemainingFraction: 0.8, status: 'ok' } },
        weekly: { remainingFraction: 0.91, resetTime: new Date(Date.now() + 5 * 86400000).toISOString(), pacing: { timeRemainingFraction: 0.75, status: 'ok' } },
      },
    ],
    quotaPair: { title: 'Gemini Models', fiveHourFraction: 0.95, weeklyFraction: 0.91 },
    usage: {
      todayDate: '2026-11-20',
      monthKey: '2026-11',
      todayTokens: 6760000,
      todayInput: 500000,
      todayCacheRead: 6000000,
      todayOutput: 260000,
      todayRequests: 40,
      todayByModel: [{ model: 'Gemini 4 Neon', totalTokens: 6760000 }],
      weekTokens: 847000000,
      monthTokens: 2710000000,
      monthInput: 240000000,
      monthCacheRead: 2410000000,
      monthOutput: 60000000,
      monthRequests: 20500,
      activeDays: 48,
      totalRequests: 28100,
      peakDay: { date: '2026-11-14', total: 445000000 },
      currentStreak: 27,
      longestStreak: 27,
      totalTokens: 3400000000,
      days: [{ date: '2026-11-20', total: 6760000 }],
      modelRank: [{ model: 'Gemini 4 Neon', totalTokens: 3400000000, outputTokens: 60000000, avgTps: 142.0, requests: 28100 }],
    },
  };

  const { doc, win } = createDomEnv(snapshot);
  t.after(() => { try { win.__agTokenMeterDispose?.(); } catch {} });
  const code = buildInlineWidgetScript();
  const fn = new Function('window', 'document', 'location', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', code);
  fn(
    win,
    doc,
    win.location,
    () => ({ display: 'flex', visibility: 'visible', opacity: '1', flexDirection: 'row', backgroundColor: '#ffffff' }),
    class { observe() {} disconnect() {} },
    class { observe() {} disconnect() {} }
  );
  await new Promise((r) => setTimeout(r, 30));

  const host = doc.querySelector('#ag-token-meter-host');
  const shadow = host.shadowRootMock;
  const pop = shadow.getElementById('tm-popover');

  // 英文 Quota 卡片必须使用等宽短标 5h/7d 且带百分号，严禁出现溢出碰撞进度条的 "Weekly"
  shadow.querySelector('[data-tm-chip="quota"]').dispatchEvent({ type: 'mouseover' });
  assert.ok(pop.innerHTML.includes('>7d<'));
  assert.ok(pop.innerHTML.includes('95%'));
  assert.ok(pop.innerHTML.includes('91%'));
  assert.equal(pop.innerHTML.includes('>Weekly<'), false);
  assert.ok(pop.innerHTML.includes('Model Quotas'));
  assert.ok(pop.innerHTML.includes('Left 5h · Right 7d'));
  assert.ok(pop.innerHTML.includes('>Copy<'));

  // 英文 Context 卡片必须输出紧凑无多余空格的 "~9 turns left"
  shadow.querySelector('[data-tm-chip="context"]').dispatchEvent({ type: 'mouseover' });
  assert.ok(pop.innerHTML.includes('~9 turns left'));
  assert.equal(pop.innerHTML.includes('~ 9 turns left'), false);

  win.__agTokenMeterDispose();
});

test('新对话首页无 conversationId 时照常拉取全局额度与本月用量，绝不变灰或空白', async (t) => {
  let calledWith = 'UNSET';
  const snapshot = {
    version: '1.2.14',
    connected: true,
    conversationUnavailable: true,
    conversation: null,
    preferences: {
      language: 'zh-CN',
      theme: 'swiss',
      showSpeed: true,
      showCache: true,
      showContext: true,
      showQuota: true,
      showToday: false,
      showMonth: true,
      version: 1,
    },
    quotas: [
      {
        title: 'Gemini Models',
        fiveHour: { remainingFraction: 0.94, resetTime: new Date(Date.now() + 3600000).toISOString(), pacing: { timeRemainingFraction: 0.8, status: 'ok' } },
        weekly: { remainingFraction: 0.90, resetTime: new Date(Date.now() + 5 * 86400000).toISOString(), pacing: { timeRemainingFraction: 0.75, status: 'ok' } },
      },
    ],
    quotaPair: { title: 'Gemini Models', fiveHourFraction: 0.94, weeklyFraction: 0.90 },
    usage: {
      todayDate: '2026-11-20',
      monthKey: '2026-11',
      todayTokens: 0,
      weekTokens: 0,
      monthTokens: 2730000000,
      totalTokens: 3420000000,
      days: [],
      modelRank: [{ model: 'Gemini 4 Neon', totalTokens: 3420000000, avgTps: 140, requests: 20000 }],
    },
  };

  const { doc, win } = createDomEnv(snapshot);
  win.location.pathname = '/';
  win.__agTokenMeterApi.getSnapshot = async (cid) => {
    calledWith = cid;
    return snapshot;
  };
  t.after(() => { try { win.__agTokenMeterDispose?.(); } catch {} });

  const code = buildInlineWidgetScript();
  const fn = new Function('window', 'document', 'location', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', code);
  fn(
    win,
    doc,
    win.location,
    () => ({ display: 'flex', visibility: 'visible', opacity: '1', flexDirection: 'row', backgroundColor: '#ffffff' }),
    class { observe() {} disconnect() {} },
    class { observe() {} disconnect() {} }
  );
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(calledWith, null, 'home page without /c/<uuid> must still fetch global snapshot with null cid');
  const host = doc.querySelector('#ag-token-meter-host');
  const shadow = host.shadowRootMock;
  const pop = shadow.getElementById('tm-popover');
  assert.ok(shadow.querySelector('[data-tm-chip="quota"]'), 'quota chip must render on new chat home');
  assert.ok(shadow.querySelector('[data-tm-chip="month"]'), 'month chip must render on new chat home');
  shadow.querySelector('[data-tm-chip="month"]').dispatchEvent({ type: 'mouseover' });
  assert.ok(pop.innerHTML.includes('2.73B'));

  win.__agTokenMeterDispose();
});
