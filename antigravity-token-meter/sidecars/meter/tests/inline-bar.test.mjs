import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInlineWidgetScript } from '../src/ui/inline-bar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = readFileSync(join(HERE, '..', 'src', 'ui', 'panel.html'), 'utf8');

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
        const langMatch = this._innerHTML.match(/id="tm-wrap"[^>]*lang="([^"]+)"/);
        if (langMatch) wrap.setAttribute('lang', langMatch[1]);
        const chips = new FakeElement('div', doc); chips.setAttribute('id', 'tm-chips');
        wrap.appendChild(chips);
        this.appendChild(wrap);
        return;
      }
      if (this._innerHTML.includes('id="tm-popover"') && !this._innerHTML.includes('id="tm-chips"')) {
        const pop = new FakeElement('div', doc); pop.setAttribute('id', 'tm-popover');
        const popLang = this._innerHTML.match(/id="tm-popover"[^>]*lang="([^"]+)"/);
        if (popLang) pop.setAttribute('lang', popLang[1]);
        this.appendChild(pop);
        return;
      }
      if (this._innerHTML.includes('id="tm-backdrop"')) {
        const bd = new FakeElement('div', doc);
        bd.setAttribute('id', 'tm-backdrop');
        const bdLang = this._innerHTML.match(/id="tm-backdrop"[^>]*lang="([^"]+)"/);
        if (bdLang) bd.setAttribute('lang', bdLang[1]);
        for (const id of ['tm-modal-scroll', 'tm-close-modal', 'tm-modal-lang', 'tm-modal-copy', 'tm-z-tip']) {
          if (this._innerHTML.includes(`id="${id}"`)) {
            const el = new FakeElement('div', doc);
            el.setAttribute('id', id);
            bd.appendChild(el);
          }
        }
        this.appendChild(bd);
        return;
      }
      if (this._innerHTML.includes('class="tm-head"')) {
        for (const id of ['tm-style-btn', 'tm-copy-btn', 'tm-lang-btn', 'tm-open-modal', 'tm-trend-readout', 'tm-spark-tip']) {
          if (this._innerHTML.includes(`id="${id}"`)) {
            const btn = new FakeElement('button', doc);
            btn.setAttribute('id', id);
            this.appendChild(btn);
          }
        }
        if (this._innerHTML.includes('id="tm-trend-svg"')) {
          const tWrap = new FakeElement('div', doc);
          const svg = new FakeElement('svg', doc);
          svg.setAttribute('id', 'tm-trend-svg');
          for (const bm of this._innerHTML.matchAll(/class="tm-trend-bar[^"]*"[^>]*data-t-idx="(\d+)"/g)) {
            const rect = new FakeElement('rect', doc);
            rect.setAttribute('class', 'tm-trend-bar');
            rect.setAttribute('data-t-idx', bm[1]);
            svg.appendChild(rect);
          }
          const tip = new FakeElement('div', doc);
          tip.setAttribute('id', 'tm-trend-tip');
          tWrap.appendChild(svg);
          tWrap.appendChild(tip);
          this.appendChild(tWrap);
        }
        return;
      }
      const chipMatches = [...this._innerHTML.matchAll(/data-tm-chip="([^"]+)"/g)];
      if (chipMatches.length > 0 && !this._innerHTML.includes('class="tm-head"')) {
        for (const m of chipMatches) {
          const btn = new FakeElement('button', doc);
          btn.setAttribute('data-tm-chip', m[1]);
          btn.setAttribute('data-tm-trigger', '1');
          btn.getBoundingClientRect = () => ({ left: 260, top: 680, right: 340, bottom: 704, width: 80, height: 24 });
          if (m[1] === 'quota') {
            const qWrap = new FakeElement('span', doc);
            qWrap.setAttribute('data-tm-v', 'quota');
            const ql = new FakeElement('span', doc); ql.setAttribute('data-tm-q', 'l');
            const qs = new FakeElement('span', doc); qs.setAttribute('class', 'tm-slash'); qs.textContent = '/';
            const qr = new FakeElement('span', doc); qr.setAttribute('data-tm-q', 'r');
            qWrap.appendChild(ql); qWrap.appendChild(qs); qWrap.appendChild(qr);
            btn.appendChild(qWrap);
          }
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
        if (typeof cur.onclick === 'function' && ev.type === 'click') cur.onclick(ev);
        cur = cur.parentElement;
      }
    }
    closest(sel) {
      const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
      let cur = this;
      while (cur) {
        for (const p of parts) {
          if (matchesSelector(cur, p)) return cur;
        }
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

  const emitDocEvent = (type, evObj = {}) => {
    const ev = Object.assign({ type }, evObj);
    const list = docListeners.get(type) || [];
    for (const fn of list) fn(ev);
    return ev;
  };

  return { doc, win, box, footer, left, right, emitDocEvent };
}

test('buildInlineWidgetScript 一格一卡按需聚焦弹窗且悬停切换互不串栏', async (t) => {
  const snapshot = {
    version: '1.2.16',
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
  const getPop = () => doc.querySelector('#ag-token-meter-pop-host')?.shadowRootMock?.getElementById('tm-popover') || null;

  // 验证底栏额度去掉 % 百分号（显示纯数字 82 / 92）
  const qWrap = shadow.querySelector('[data-tm-v="quota"]');
  assert.equal(qWrap.querySelector('[data-tm-q="l"]').textContent, '82');
  assert.equal(qWrap.querySelector('[data-tm-q="r"]').textContent, '92');

  const expectByChip = {
    speed: { must: ['生成速率', '134.4', '会话均速', 'tm-spark-svg', 'tm-sp-node', 'tm-spark-tip', '>中<'], forbid: ['模型额度', '今日模型分布', '近 14 天趋势', '~$12.34', '>EN<'] },
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
    const pop = getPop();
    assert.ok(pop, 'popover portal host must mount directly under document.body');
    assert.equal(doc.querySelector('#ag-token-meter-pop-host').parentElement, doc.body);
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
  assert.equal(getPop().classList.contains('open'), true);
  assert.ok(getPop().innerHTML.includes('Gemini Models'));
  quotaChip.dispatchEvent({ type: 'click' });
  assert.equal(getPop().classList.contains('open'), false);

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

  // 缩窄到中等聊天框（775px，可用空间 ~417px >= 407px -> 命中 compact 档，6 项含 7 字符大数全保留不掉行）
  footer.getBoundingClientRect = () => ({ left: 100, top: 676, right: 875, bottom: 708, width: 775, height: 32 });
  resizeCb?.();
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(host.getAttribute('data-placement'), 'inline-footer');
  assert.equal(host.getAttribute('data-density'), 'compact');
  assert.equal(shadow.querySelectorAll('[data-tm-chip]').length, 6);

  // 缩窄到 730px（可用空间 ~372px < 407px -> 提前安全切入 tight 收纳档，绝不让大额 Token 挤压右侧按钮）
  footer.getBoundingClientRect = () => ({ left: 100, top: 676, right: 830, bottom: 708, width: 730, height: 32 });
  resizeCb?.();
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(host.getAttribute('data-density'), 'tight');

  // 继续缩窄到窄分屏（560px，可用空间 ~202px -> 命中 tight 档，核心项 + "+N" 溢出胶囊）
  footer.getBoundingClientRect = () => ({ left: 100, top: 676, right: 660, bottom: 708, width: 560, height: 32 });
  resizeCb?.();
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(host.getAttribute('data-placement'), 'inline-footer');
  assert.equal(host.getAttribute('data-density'), 'tight');
  const moreChip = shadow.querySelector('[data-tm-chip="more"]');
  assert.ok(moreChip, 'narrow split should display +N overflow chip');
  moreChip.dispatchEvent({ type: 'mouseover' });
  assert.ok(getPop().innerHTML.includes('更多指标'));

  win.__agTokenMeterDispose();
  assert.equal(doc.querySelector('#ag-token-meter-pop-host'), null);
});

test('英文模式浮卡排版防溢出：进度条短标 5h/7d 无重叠、无多余空格且底栏宽窄自适应', async (t) => {
  const snapshot = {
    version: '1.2.16',
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
  const getPop = () => doc.querySelector('#ag-token-meter-pop-host')?.shadowRootMock?.getElementById('tm-popover');

  // 英文 Quota 卡片必须使用等宽短标 5h/7d 且带百分号，严禁出现溢出碰撞进度条的 "Weekly"，且语言按钮在英文下显示 EN
  shadow.querySelector('[data-tm-chip="quota"]').dispatchEvent({ type: 'mouseover' });
  const pop = getPop();
  assert.ok(pop.innerHTML.includes('>7d<'));
  assert.ok(pop.innerHTML.includes('95%'));
  assert.ok(pop.innerHTML.includes('91%'));
  assert.equal(pop.innerHTML.includes('>Weekly<'), false);
  assert.ok(pop.innerHTML.includes('Model Quotas'));
  assert.ok(pop.innerHTML.includes('Left 5h · Right 7d'));
  assert.ok(pop.innerHTML.includes('>Copy<'));
  assert.ok(pop.innerHTML.includes('>EN<'));

  // 英文 Context 卡片必须输出紧凑无多余空格的 "~9 turns left"
  shadow.querySelector('[data-tm-chip="context"]').dispatchEvent({ type: 'mouseover' });
  assert.ok(pop.innerHTML.includes('~9 turns left'));
  assert.equal(pop.innerHTML.includes('~ 9 turns left'), false);

  win.__agTokenMeterDispose();
});

test('新对话首页无 conversationId 时照常拉取全局额度与本月用量，绝不变灰或空白', async (t) => {
  let calledWith = 'UNSET';
  const snapshot = {
    version: '1.2.16',
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
  assert.ok(shadow.querySelector('[data-tm-chip="quota"]'), 'quota chip must render on new chat home');
  assert.ok(shadow.querySelector('[data-tm-chip="month"]'), 'month chip must render on new chat home');
  shadow.querySelector('[data-tm-chip="month"]').dispatchEvent({ type: 'mouseover' });
  const pop = doc.querySelector('#ag-token-meter-pop-host').shadowRootMock.getElementById('tm-popover');
  assert.ok(pop.innerHTML.includes('2.73B'));

  // 新对话首页悬停生成速率与上下文时应展示温和友好的新对话引导提示
  shadow.querySelector('[data-tm-chip="speed"]').dispatchEvent({ type: 'mouseover' });
  assert.ok(pop.innerHTML.includes('发送首条消息后实时统计当前对话'));
  shadow.querySelector('[data-tm-chip="context"]').dispatchEvent({ type: 'mouseover' });
  assert.ok(pop.innerHTML.includes('发送首条消息后实时统计当前对话'));

  win.__agTokenMeterDispose();
});

test('跨平台 CJK 字体栈、宿主原生字体统一、字号下限与 lang 属性实时同步核验', async (t) => {
  const code = buildInlineWidgetScript();
  const cjkRequired = [
    '"PingFang SC"',
    '"Hiragino Sans GB"',
    '"Microsoft YaHei UI"',
    '"Microsoft YaHei"',
    '"Source Han Sans SC"',
    '"Noto Sans CJK SC"',
  ];

  for (const [label, source] of [['inline-bar.mjs', code], ['panel.html', PANEL_HTML]]) {
    const sansMatch = source.match(/--tm-sans:\s*([^;]+);/);
    const monoMatch = source.match(/--tm-mono:\s*([^;]+);/);
    assert.ok(sansMatch, `${label} must define --tm-sans`);
    assert.ok(monoMatch, `${label} must define --tm-mono`);
    assert.ok(sansMatch[1].includes('"Google Sans Flex"'), `${label} --tm-sans should align with host Google Sans Flex`);
    assert.ok(source.includes('--tm-num: var(--tm-sans)'), `${label} must unify Swiss/Glass numbers onto --tm-sans`);
    assert.ok(source.includes('--tm-num: var(--tm-mono)'), `${label} must scope monospace numbers to Mono theme`);
    for (const fontName of cjkRequired) {
      assert.ok(sansMatch[1].includes(fontName), `${label} --tm-sans must include ${fontName}`);
      const monoIdx = monoMatch[1].lastIndexOf('monospace');
      const cjkIdx = monoMatch[1].indexOf(fontName);
      assert.ok(cjkIdx >= 0 && cjkIdx < monoIdx, `${label} --tm-mono must declare ${fontName} BEFORE generic monospace`);
    }
    const fontSizes = [...source.matchAll(/font-size\s*:\s*([0-9.]+)px/g)].map((m) => Number(m[1]));
    assert.ok(fontSizes.length > 0);
    for (const px of fontSizes) {
      assert.ok(px >= 10.5, `${label} font-size ${px}px is below 10.5px readability floor`);
    }
  }

  const snapshot = {
    version: '1.2.16',
    connected: true,
    preferences: { language: 'zh-CN', theme: 'mono', showSpeed: true, showMonth: true, version: 1 },
    conversation: { model: 'Gemini 4 Carbon', latestTps: 98.5, tps: 98.5, sparkline: [{ tps: 98.5, ttft: 1.25, tokens: 320 }] },
    quotas: [],
    usage: { todayDate: '2026-11-20', monthKey: '2026-11', todayTokens: 1200, monthTokens: 54000, totalTokens: 54000, days: [] },
  };

  const { doc, win } = createDomEnv(snapshot);
  t.after(() => { try { win.__agTokenMeterDispose?.(); } catch {} });
  const fn = new Function('window', 'document', 'location', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', code);
  fn(
    win,
    doc,
    win.location,
    () => ({ display: 'flex', visibility: 'visible', opacity: '1', flexDirection: 'row', backgroundColor: '#121214' }),
    class { observe() {} disconnect() {} },
    class { observe() {} disconnect() {} }
  );
  await new Promise((r) => setTimeout(r, 30));

  const host = doc.querySelector('#ag-token-meter-host');
  const shadow = host.shadowRootMock;
  const wrap = shadow.getElementById('tm-wrap');
  assert.equal(host.getAttribute('lang'), 'zh-CN');
  assert.equal(wrap.getAttribute('lang'), 'zh-CN');

  // 首轮对话仅 1 个测速样本时，应渲染单点可交互折线基线而非“暂无统计数据”；中文模式按钮显示「中」
  shadow.querySelector('[data-tm-chip="speed"]').dispatchEvent({ type: 'mouseover' });
  const popHost = doc.querySelector('#ag-token-meter-pop-host');
  const pop = popHost.shadowRootMock.getElementById('tm-popover');
  assert.ok(pop.innerHTML.includes('id="tm-spark-svg"'));
  assert.ok(pop.innerHTML.includes('>中<'));
  assert.equal(pop.innerHTML.includes('暂无统计数据'), false);

  // 点击浮卡语言切换按钮后，Shadow Host、浮卡 Portal 与弹窗根节点同步切换为 lang="en" 且按钮显示「EN」
  const langBtn = pop.querySelector('#tm-lang-btn');
  assert.ok(langBtn);
  langBtn.dispatchEvent({ type: 'click', isTrusted: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(host.getAttribute('lang'), 'en');
  assert.equal(wrap.getAttribute('lang'), 'en');
  assert.equal(popHost.getAttribute('lang'), 'en');
  assert.ok(pop.innerHTML.includes('>EN<'));

  const openModalBtn = pop.querySelector('#tm-open-modal');
  openModalBtn.dispatchEvent({ type: 'click', isTrusted: true });
  const modalHost = doc.querySelector('#ag-token-meter-modal-host');
  assert.ok(modalHost);
  assert.equal(modalHost.getAttribute('lang'), 'en');
  assert.equal(modalHost.shadowRootMock.getElementById('tm-backdrop').getAttribute('lang'), 'en');
  assert.ok(modalHost.shadowRootMock.innerHTML.includes('>EN<'));

  win.__agTokenMeterDispose();
});

test('费用展示口径对齐与 <$0.01 微额高精度提示（含会话、缓存节省、今日模型、14天柱图微浮卡与统计弹窗）', async (t) => {
  const snapshot = {
    version: '1.2.16',
    connected: true,
    preferences: {
      language: 'zh-CN',
      theme: 'swiss',
      showSpeed: true,
      showCache: true,
      showContext: true,
      showQuota: false,
      showToday: true,
      showMonth: true,
      showCost: true,
      version: 3,
    },
    conversation: {
      model: 'Claude Opus 4.6',
      running: false,
      latestTps: 65.2,
      tps: 64.0,
      ttftSeconds: 1.8,
      streamingSeconds: 8.5,
      measuredRequests: 2,
      requests: 2,
      cacheHitRate: 0.92,
      costUsd: 0.0038,
      cacheSavingsUsd: 0.0085,
      pricing: { family: 'Claude Opus 4.6', inputPer1M: 10, cacheReadPer1M: 1, outputPer1M: 37.5, exact: true, longContextApplied: true },
      lastRequestTime: new Date().toISOString(),
      tokens: { total: 260000, inputAll: 255000, uncachedInput: 5000, cacheWrite: 15000, cacheRead: 235000, output: 5000, responseOutput: 3800, thinkingOutput: 1200 },
      sparkline: [{ tps: 62 }, { tps: 65.2 }],
    },
    quotas: [],
    usage: {
      todayDate: '2026-11-20',
      monthKey: '2026-11',
      todayTokens: 320000,
      todayCostUsd: 0.0042,
      todayInput: 20000,
      todayCacheRead: 290000,
      todayOutput: 10000,
      todayRequests: 3,
      todayByModel: [{ model: 'Claude Opus 4.6', totalTokens: 320000 }],
      weekTokens: 900000,
      weekCostUsd: 1.45,
      monthTokens: 15000000,
      monthCostUsd: 18.6,
      monthInput: 1000000,
      monthCacheRead: 13500000,
      monthOutput: 500000,
      monthRequests: 85,
      activeDays: 12,
      totalTokens: 50000000,
      totalCostUsd: 64.25,
      lifetimeCacheSavingsUsd: 128.5,
      days: [
        { date: '2026-11-19', total: 4800000, requests: 25, costUsd: 5.4, byModel: { 'Claude Opus 4.6': 4800000 }, byModelCost: { 'Claude Opus 4.6': 5.4 } },
        { date: '2026-11-20', total: 320000, requests: 3, costUsd: 0.0042, byModel: { 'Claude Opus 4.6': 320000 }, byModelCost: { 'Claude Opus 4.6': 0.0042 } },
      ],
      modelRank: [
        { model: 'Claude Opus 4.6', totalTokens: 50000000, outputTokens: 1200000, avgTps: 64.0, requests: 210, costUsd: 64.25, pricing: { family: 'Claude Opus 4.6', inputPer1M: 5, cacheReadPer1M: 0.5, outputPer1M: 25, exact: true } },
      ],
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
  const getPop = () => doc.querySelector('#ag-token-meter-pop-host')?.shadowRootMock?.getElementById('tm-popover');

  // 1. Speed 卡：< $0.01 非零微额展示为 <$0.01（严禁出现误导性的 $0.00），且悬停提示包含高精度 ~$0.0038 与 (>200K) 阶梯标记
  shadow.querySelector('[data-tm-chip="speed"]').dispatchEvent({ type: 'mouseover' });
  const pop = getPop();
  assert.ok(pop.innerHTML.includes('&lt;$0.01'));
  assert.equal(/\$0\.00(?![0-9])/.test(pop.innerHTML), false);
  assert.ok(pop.innerHTML.includes('~$0.0038'));
  assert.ok(pop.innerHTML.includes('(&gt;200K)') || pop.innerHTML.includes('(>200K)'));

  // 2. Cache 卡：展示本会话缓存节省金额
  shadow.querySelector('[data-tm-chip="cache"]').dispatchEvent({ type: 'mouseover' });
  assert.ok(pop.innerHTML.includes('缓存节省 &lt;$0.01'));
  assert.ok(pop.innerHTML.includes('~$0.0085'));

  // 3. Today 卡：顶部微额徽章与今日模型分布同步展示模型级花费
  shadow.querySelector('[data-tm-chip="today"]').dispatchEvent({ type: 'mouseover' });
  assert.ok(pop.innerHTML.includes('tm-cost-val'));
  assert.ok(pop.innerHTML.includes('&lt;$0.01'));

  // 4. Month 卡：悬停 14 天趋势柱状图时，右上角读数与微浮卡实时展示当日花费（含 $5.40 与 <$0.01）
  shadow.querySelector('[data-tm-chip="month"]').dispatchEvent({ type: 'mouseover' });
  assert.ok(pop.innerHTML.includes('~$18.60'));
  const bars = pop.querySelectorAll('.tm-trend-bar');
  assert.equal(bars.length, 14);
  bars[12].dispatchEvent({ type: 'mouseover', target: bars[12] });
  assert.ok(pop.querySelector('#tm-trend-readout').textContent.includes('~$5.40'));
  assert.ok(pop.querySelector('#tm-trend-tip').innerHTML.includes('~$5.40'));
  bars[13].dispatchEvent({ type: 'mouseover', target: bars[13] });
  assert.ok(pop.querySelector('#tm-trend-readout').textContent.includes('<$0.01'));
  assert.ok(pop.querySelector('#tm-trend-tip').innerHTML.includes('&lt;$0.01'));

  // 5. 统计大弹窗：KPI、趋势副标与模型圆环列表费用统一展示
  pop.querySelector('#tm-open-modal').dispatchEvent({ type: 'click', isTrusted: true });
  const modalShadow = doc.querySelector('#ag-token-meter-modal-host').shadowRootMock;
  assert.ok(modalShadow.innerHTML.includes('~$64.25'));
  assert.ok(modalShadow.innerHTML.includes('缓存节省 ~$128.50'));
  assert.ok(modalShadow.innerHTML.includes('~$5.40'));

  win.__agTokenMeterDispose();
});

test('前端交互体验：Esc 精准关闭弹窗/浮卡并阻断冒泡防误停生成，点击外部立即收起', async (t) => {
  const snapshot = {
    version: '1.2.16',
    connected: true,
    preferences: { language: 'zh-CN', theme: 'glass', showSpeed: true, showQuota: true, version: 1 },
    conversation: { model: 'Gemini 4 Neon', running: true, latestTps: 128.0, tps: 128.0, sparkline: [{ tps: 120 }, { tps: 128 }] },
    quotas: [{ title: 'Gemini Models', remainingFraction: 0.85, windowKind: '5h' }],
    quotaPair: { title: 'Gemini Models', fiveHourFraction: 0.85, weeklyFraction: 0.90 },
    usage: { todayDate: '2026-11-20', monthKey: '2026-11', todayTokens: 1000, monthTokens: 5000, totalTokens: 5000, days: [] },
  };

  const { doc, win, box, emitDocEvent } = createDomEnv(snapshot);
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
  const getPop = () => doc.querySelector('#ag-token-meter-pop-host')?.shadowRootMock?.getElementById('tm-popover');

  // 未打开任何浮卡或弹窗时，按 Escape 绝不拦截宿主键盘事件
  let stopped = false;
  let prevented = false;
  emitDocEvent('keydown', { key: 'Escape', stopPropagation: () => { stopped = true; }, preventDefault: () => { prevented = true; } });
  assert.equal(stopped, false);
  assert.equal(prevented, false);

  // 悬停打开浮卡 -> 点击聊天框外部立即收起浮卡
  shadow.querySelector('[data-tm-chip="speed"]').dispatchEvent({ type: 'mouseover' });
  const pop = getPop();
  assert.equal(pop.classList.contains('open'), true);
  emitDocEvent('click', { target: box, composedPath: () => [box, doc.body, doc.documentElement] });
  assert.equal(pop.classList.contains('open'), false);

  // 重新打开浮卡并按 Escape -> 关闭浮卡且调用 preventDefault + stopPropagation 保护宿主正在运行的生成
  shadow.querySelector('[data-tm-chip="speed"]').dispatchEvent({ type: 'click' });
  assert.equal(pop.classList.contains('open'), true);
  emitDocEvent('keydown', { key: 'Escape', stopPropagation: () => { stopped = true; }, preventDefault: () => { prevented = true; } });
  assert.equal(pop.classList.contains('open'), false);
  assert.equal(stopped, true);
  assert.equal(prevented, true);

  // 打开统计大弹窗并按 Escape -> 干净移除弹窗且拦截事件冒泡
  shadow.querySelector('[data-tm-chip="speed"]').dispatchEvent({ type: 'mouseover' });
  pop.querySelector('#tm-open-modal').dispatchEvent({ type: 'click', isTrusted: true });
  assert.ok(doc.querySelector('#ag-token-meter-modal-host'));
  stopped = false;
  prevented = false;
  emitDocEvent('keydown', { key: 'Escape', stopPropagation: () => { stopped = true; }, preventDefault: () => { prevented = true; } });
  assert.equal(doc.querySelector('#ag-token-meter-modal-host'), null);
  assert.equal(stopped, true);
  assert.equal(prevented, true);

  win.__agTokenMeterDispose();
});

test('computeBarLayout 首项 leadStar 解耦与 7 字符大额 Token（如 892.34M）宽度预算核验', async (t) => {
  // 关闭 showSpeed，仅开启 cache + month（首项变为 cache，自动承担 leadStar 额外宽度）
  const snapshot = {
    version: '1.2.16',
    connected: true,
    preferences: {
      language: 'zh-CN',
      theme: 'swiss',
      showSpeed: false,
      showCache: true,
      showContext: false,
      showQuota: false,
      showToday: false,
      showMonth: true,
      version: 1,
    },
    conversation: { model: 'Gemini 4 Carbon', cacheHitRate: 1.0 },
    quotas: [],
    usage: { todayDate: '2026-11-20', monthKey: '2026-11', todayTokens: 892340000, monthTokens: 892340000, totalTokens: 892340000, days: [] },
  };

  const { doc, win, footer } = createDomEnv(snapshot);
  t.after(() => { try { win.__agTokenMeterDispose?.(); } catch {} });
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
  await new Promise((r) => setTimeout(r, 30));

  const host = doc.querySelector('#ag-token-meter-host');
  const shadow = host.shadowRootMock;

  // cache(92) + month(90) + sep(5) + leadStarFull(20) = 207px
  // 当 freeWidth = 198px（footer=556 -> 556-170-170-18=198 < 207）时，因计入了首项 leadStar(20)，必须安全降级到 compact 而非误判 full 溢出
  footer.getBoundingClientRect = () => ({ left: 100, top: 676, right: 656, bottom: 708, width: 556, height: 32 });
  resizeCb?.();
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(host.getAttribute('data-density'), 'compact');

  // compact 下 cache(60) + month(70) + sep(5) + leadStarCompact(18) = 153px
  // 当 freeWidth = 148px（footer=506 -> 148 < 153）时，安全切入 tight（仅保留优先级更高的 month + "+1" 胶囊，所需 70+18+38=126 <= 148）
  footer.getBoundingClientRect = () => ({ left: 100, top: 676, right: 606, bottom: 708, width: 506, height: 32 });
  resizeCb?.();
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(host.getAttribute('data-density'), 'tight');
  assert.ok(shadow.querySelector('[data-tm-chip="month"]'));
  assert.ok(shadow.querySelector('[data-tm-chip="more"]'));

  // 当 freeWidth = 90px（footer=448 -> 90 < 96）时，切入 mini 仅展示星标 +2 胶囊
  footer.getBoundingClientRect = () => ({ left: 100, top: 676, right: 548, bottom: 708, width: 448, height: 32 });
  resizeCb?.();
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(host.getAttribute('data-density'), 'mini');

  win.__agTokenMeterDispose();
});
