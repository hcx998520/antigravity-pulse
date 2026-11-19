/**
 * 隔离世界运行的 Shadow DOM 底部状态条脚本生成器。
 *
 * 核心特性：
 * 1. 三套精选零 AI 味视觉主题（swiss 瑞士精密 / glass 液态磨砂 / mono 极客终端），浅深色自适应；
 * 2. 底部状态条全透明无边框、原地骨架复用更新（上下文圆环 0–100% 无级跟进 + 四角星连续不中断）；
 * 3. 左 5h / 右周额度（100/100）双轨进度条 + 时间基准节奏刻度线（Pace Tick）；
 * 4. Prompt Cache 保鲜度、思考占比、上下文剩余轮次与一键复制脱敏摘要；
 * 5. 安全边界：Isolated World + Closed Shadow DOM + requestSeq 防串会话 + e.isTrusted 校验。
 */
import { I18N_DICT } from '../i18n.mjs';

export function buildInlineWidgetScript() {
  const dictJson = JSON.stringify(I18N_DICT);
  return `(function(I18N){
    if (window !== window.top) return;
    if (window.__agTokenMeterMounted) return;

    var HOST_ID = 'ag-token-meter-host';
    var MODAL_ID = 'ag-token-meter-modal-host';
    var EXACT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    var THEMES = ['swiss', 'glass', 'mono'];

    var state = {
      disposed: false,
      snapshot: null,
      prefs: { language: 'zh-CN', theme: 'swiss', showSpeed: true, showCache: true, showContext: true, showQuota: true, showToday: false, showMonth: true, version: 0 },
      confirmedPrefVersion: 0,
      prefPendingCount: 0,
      popoverOpen: false,
      pinned: false,
      activeTab: 'speed',
      pointerInPop: false,
      hoveringPopChart: false,
      lastRenderedTab: '',
      lastPopHtml: '',
      modalOpen: false,
      modalActivityMode: 'daily',
      modalRangeDays: 7,
      modalTrendModel: 'ALL',
      lastModalHtml: '',
      dark: false,
      lastCid: null,
      barLayoutKey: '',
      freeWidth: 999,
      density: 'full',
      overflowTabs: [],
      copiedUntil: 0,
      requestSeq: 0,
      hoverTimer: null,
    };

    var hostEl = null;
    var shadow = null;
    var modalHost = null;
    var modalShadow = null;
    var observer = null;
    var resizeObserver = null;
    var observedFooter = null;
    var resizeDebounce = null;
    var pollTimer = null;
    var mountDebounce = null;
    var scrollRaf = 0;

    function fmtFixed(v, digits) {
      if (v === null || v === undefined || v === '') return null;
      var n = Number(v);
      return Number.isFinite(n) ? n.toFixed(digits) : null;
    }

    /**
     * 优先以服务端返回的本地日期键（YYYY-MM-DD）作为图表日历基准，避免跨零点前后端 1 秒差导致双柱亮蓝或错位。
     */
    function parseBaseDate(todayDate) {
      if (typeof todayDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(todayDate)) {
        var parts = todayDate.split('-').map(Number);
        var d = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
        if (Number.isFinite(d.getTime())) return d;
      }
      var now = new Date();
      now.setHours(12, 0, 0, 0);
      return now;
    }

    function t(key) {
      var lang = state.prefs && state.prefs.language === 'en' ? 'en' : 'zh-CN';
      return (I18N[lang] && I18N[lang][key]) || I18N['zh-CN'][key] || key;
    }

    function currentStyle() {
      var th = state.prefs && state.prefs.theme;
      return THEMES.indexOf(th) >= 0 ? th : 'swiss';
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function(ch) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
      });
    }

    function safeInt(v) {
      var n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    }

    function fmtTokens(n) {
      var v = safeInt(n);
      if (v <= 0) return '0';
      if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
      if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
      return String(v);
    }

    /**
     * 统计大弹窗摘要专用紧凑格式化：中文模式下自动采用「万 / 亿」并保留数字与单位间距（如 33.9 亿），英文保持 K/M/B。
     */
    function fmtStatsTokens(n) {
      var v = safeInt(n);
      if (v <= 0) return '0';
      if (state.prefs && state.prefs.language !== 'en') {
        if (v >= 1e8) return (v / 1e8).toFixed(v >= 1e9 ? 1 : 2) + ' 亿';
        if (v >= 1e4) return (v / 1e4).toFixed(v >= 1e6 ? 0 : 1) + ' 万';
        return v.toLocaleString();
      }
      return fmtTokens(v);
    }

    function fmtPct(frac) {
      if (typeof frac !== 'number' || !Number.isFinite(frac)) return '--';
      return Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    }

    function fmtPctNum(frac) {
      if (typeof frac !== 'number' || !Number.isFinite(frac)) return '--';
      return String(Math.round(Math.max(0, Math.min(1, frac)) * 100));
    }

    function resolveQuotaKind(q) {
      if (!q) return null;
      if (q.windowKind === '5h' || q.windowKind === 'week') return q.windowKind;
      if (q.resetTime) {
        var ms = Date.parse(q.resetTime) - Date.now();
        if (Number.isFinite(ms) && ms > 0) {
          if (ms <= 5.5 * 3600000) return '5h';
          if (ms <= 8 * 86400000) return 'week';
        }
      }
      return null;
    }

    function fmtUsd(usd) {
      var v = Number(usd);
      if (!Number.isFinite(v) || v < 0) return null;
      if (v === 0) return '$0.00';
      if (v < 0.01) return '<$0.01';
      if (v >= 1000) return '$' + (v / 1000).toFixed(2) + 'K';
      return '$' + v.toFixed(2);
    }

    function getQuotaPairParts(pair, fallbackQuota) {
      var p = pair;
      if (!p && fallbackQuota) {
        var kind = resolveQuotaKind(fallbackQuota);
        p = {
          fiveHourFraction: fallbackQuota.fiveHour ? fallbackQuota.fiveHour.remainingFraction : kind === '5h' ? fallbackQuota.remainingFraction : null,
          weeklyFraction: fallbackQuota.weekly ? fallbackQuota.weekly.remainingFraction : kind === 'week' ? fallbackQuota.remainingFraction : null,
          fallbackFraction: fallbackQuota.remainingFraction,
        };
      }
      if (!p) return { single: '--' };
      var has5h = typeof p.fiveHourFraction === 'number' && Number.isFinite(p.fiveHourFraction);
      var hasWk = typeof p.weeklyFraction === 'number' && Number.isFinite(p.weeklyFraction);
      if (has5h || hasWk) {
        return {
          left: fmtPct(has5h ? p.fiveHourFraction : null),
          right: fmtPct(hasWk ? p.weeklyFraction : null),
        };
      }
      return { single: fmtPct(p.fallbackFraction) };
    }

    function fmtCountdown(iso) {
      if (!iso) return '--';
      var ms = Date.parse(iso) - Date.now();
      if (!Number.isFinite(ms)) return '--';
      if (ms <= 0) return '0m';
      var mins = Math.floor(ms / 60000);
      var hrs = Math.floor(mins / 60);
      var days = Math.floor(hrs / 24);
      if (days > 0) return days + 'd ' + (hrs % 24) + 'h';
      if (hrs > 0) return hrs + 'h ' + (mins % 60) + 'm';
      return mins + 'm';
    }

    function getCacheFreshness(lastRequestIso) {
      if (!lastRequestIso) return null;
      var ms = Date.now() - Date.parse(lastRequestIso);
      if (!Number.isFinite(ms) || ms < 0) return null;
      var sec = Math.floor(ms / 1000);
      var ageText = sec < 60 ? sec + 's' : sec < 3600 ? Math.floor(sec / 60) + 'm' : Math.floor(sec / 3600) + 'h';
      if (sec <= 270) return { cls: 'warm', label: t('cacheWarm') + ' ' + ageText };
      if (sec <= 600) return { cls: 'cool', label: t('cacheCooling') + ' ' + ageText };
      return { cls: 'cold', label: t('cacheCold') + ' ' + ageText };
    }

    function buildCopySummaryText() {
      var snap = state.snapshot || {};
      var conv = snap.conversation || {};
      var usage = snap.usage || {};
      var leadQ = (snap.quotas && snap.quotas[0]) || null;
      var qParts = getQuotaPairParts(snap.quotaPair, leadQ);
      var qText = qParts.single !== undefined ? qParts.single : (qParts.left + '/' + qParts.right);
      var parts = ['✦ TokenMeter'];
      if (conv.model) parts.push(String(conv.model));
      var latestFixed = fmtFixed(conv.latestTps, 1);
      var avgFixed = fmtFixed(conv.tps, 1);
      if (latestFixed !== null) parts.push(latestFixed + ' tok/s' + (avgFixed !== null ? ' (avg ' + avgFixed + ')' : ''));
      if (conv.cacheHitRate != null) parts.push('Cache ' + fmtPct(conv.cacheHitRate));
      if (conv.context && conv.context.usedFraction != null) parts.push('Ctx ' + fmtPct(conv.context.usedFraction));
      if (qText !== '--') parts.push('Quota ' + qText);
      if (usage.todayTokens) parts.push('Today ' + fmtTokens(usage.todayTokens));
      if (usage.monthTokens) parts.push('Month ' + fmtTokens(usage.monthTokens));
      return parts.join(' | ');
    }

    function copyTextSafe(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          void navigator.clipboard.writeText(text);
          return true;
        }
      } catch {}
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }

    function detectDarkTheme() {
      try {
        if (document.documentElement.classList.contains('dark') || document.body?.classList?.contains('dark')) return true;
        var el = document.body || document.documentElement;
        var bg = el ? getComputedStyle(el).backgroundColor : '';
        var m = bg && bg.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([\\d.]+))?\\s*\\)/);
        if (m) {
          var alpha = m[4] === undefined ? 1 : Number(m[4]);
          if (alpha > 0.2) {
            var lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
            return lum < 0.45;
          }
        }
        return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      } catch {
        return false;
      }
    }

    function isVisible(el) {
      if (!el || !el.isConnected) return false;
      if (el.closest && el.closest('[inert],[aria-hidden="true"]')) return false;
      var style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      var r = el.getBoundingClientRect();
      return r.width > 12 && r.height > 12;
    }

    function detectConversationId() {
      try {
        var m = location.pathname.match(/\\/c\\/([^/?#]+)/i);
        if (m && EXACT_UUID_RE.test(m[1])) return m[1];
        if (hostEl && hostEl.isConnected) {
          var owner = hostEl.closest('[data-cascade-id]');
          var cid = owner && owner.getAttribute('data-cascade-id');
          if (cid && EXACT_UUID_RE.test(cid)) return cid;
        }
      } catch {}
      return null;
    }

    function findComposerContainer() {
      var boxes = Array.from(document.querySelectorAll('[data-testid="agent-input-box"]')).filter(isVisible);
      if (boxes.length > 0) return boxes[boxes.length - 1];

      var editors = Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"], [role="combobox"][contenteditable="true"], [aria-label="Message input"]')).filter(isVisible);
      for (var i = editors.length - 1; i >= 0; i--) {
        var cur = editors[i].parentElement;
        for (var depth = 0; depth < 6 && cur && cur !== document.body; depth++) {
          if (cur.querySelector('[data-testid="model-selector-trigger"], [data-testid="send-button"], [data-testid="stop-button"]')) {
            return cur;
          }
          cur = cur.parentElement;
        }
      }
      return null;
    }

    /**
     * 精确测量输入框底栏（.agy-composer-footer）中左侧模型区与右侧操作组之间的真实可用空白宽度。
     */
    function measureFooterFreeWidth(footer, rightGroup) {
      var fRect = footer.getBoundingClientRect();
      var fw = fRect.width || 0;
      if (fw <= 0) return 999;

      var rRect = rightGroup.getBoundingClientRect();
      var rightUsed = rRect.width > 0 && rRect.width < fw ? rRect.width : 170;

      var leftUsed = 0;
      var kids = Array.from(footer.children || []);
      for (var i = 0; i < kids.length; i++) {
        var ch = kids[i];
        if (ch === hostEl || ch === rightGroup || !isVisible(ch)) continue;
        // 左侧容器常为 flex-1，需向内量实际可见按钮的右边界，而非被撑满的容器宽度
        var innerBtns = ch.querySelectorAll ? Array.from(ch.querySelectorAll('button, [role="button"], [data-testid="model-selector-trigger"]')).filter(isVisible) : [];
        if (innerBtns.length > 0) {
          for (var j = 0; j < innerBtns.length; j++) {
            var br = innerBtns[j].getBoundingClientRect();
            var relRight = Math.min(br.right - fRect.left, fw - rightUsed);
            if (relRight > leftUsed) leftUsed = relRight;
          }
        } else {
          var cr = ch.getBoundingClientRect();
          if (cr.width > 0 && cr.width < fw * 0.55) {
            leftUsed = Math.max(leftUsed, cr.right - fRect.left);
          }
        }
      }
      if (leftUsed <= 0) leftUsed = Math.min(200, Math.round(fw * 0.28));
      return Math.max(0, Math.round(fw - leftUsed - rightUsed - 18));
    }

    /**
     * 始终优先定位在输入框底栏（.agy-composer-footer）右侧操作组之前；
     * 缩窄时通过四级渐进自适应（full → compact → tight(+N) → mini）保持同排齐平，绝不掉到输入框下方。
     */
    function findMountAnchor() {
      var box = findComposerContainer();
      if (!box) return null;

      var footer = box.querySelector('.agy-composer-footer');
      if (!footer) {
        var permBtn = box.querySelector('[data-testid="permissions-selector-trigger"], [data-testid="send-button"], [data-testid="stop-button"]');
        if (permBtn) {
          var p = permBtn.parentElement;
          for (var d = 0; d < 4 && p && p !== box; d++) {
            var cs = getComputedStyle(p);
            if (cs.display === 'flex' && cs.flexDirection === 'row' && p.children.length >= 2) {
              footer = p;
              break;
            }
            p = p.parentElement;
          }
        }
      }

      if (footer && isVisible(footer)) {
        var rightGroup = null;
        var anchorTrigger = footer.querySelector('[data-testid="permissions-selector-trigger"], [data-testid="send-button"], [data-testid="stop-button"]');
        if (anchorTrigger) {
          var cur = anchorTrigger;
          while (cur && cur.parentElement && cur.parentElement !== footer) {
            cur = cur.parentElement;
          }
          if (cur && cur.parentElement === footer) rightGroup = cur;
        }
        if (!rightGroup && footer.children.length >= 2) {
          rightGroup = footer.lastElementChild;
        }
        if (rightGroup) {
          return {
            parent: footer,
            before: rightGroup,
            placement: 'inline-footer',
            freeWidth: measureFooterFreeWidth(footer, rightGroup),
          };
        }
      }

      return { parent: box, before: null, placement: 'below', freeWidth: 999 };
    }

    /**
     * 四级渐进自适应布局计算：按底栏剩余真实宽度决定 full / compact / tight(+N) / mini。
     */
    function computeBarLayout(enabledTabs, freeWidth) {
      if (!enabledTabs.length) return { density: 'full', shown: [], hidden: [] };
      var isEn = state.prefs && state.prefs.language === 'en';
      var fullW = isEn
        ? { speed: 92, cache: 98, context: 96, quota: 106, today: 94, month: 92 }
        : { speed: 88, cache: 86, context: 86, quota: 94, today: 88, month: 78 };
      var compactW = isEn
        ? { speed: 58, cache: 66, context: 48, quota: 72, today: 68, month: 62 }
        : { speed: 56, cache: 56, context: 48, quota: 72, today: 58, month: 54 };
      var sepW = 5;

      var totalFull = enabledTabs.reduce(function(acc, k) { return acc + (fullW[k] || 76); }, 0) + Math.max(0, enabledTabs.length - 1) * sepW;
      if (freeWidth >= totalFull) {
        return { density: 'full', shown: enabledTabs.slice(), hidden: [] };
      }

      var totalCompact = enabledTabs.reduce(function(acc, k) { return acc + (compactW[k] || 54); }, 0) + Math.max(0, enabledTabs.length - 1) * sepW;
      if (freeWidth >= totalCompact) {
        return { density: 'compact', shown: enabledTabs.slice(), hidden: [] };
      }

      if (freeWidth < 102) {
        return { density: 'mini', shown: [], hidden: enabledTabs.slice() };
      }

      // tight 档：按核心优先级尽量保留能放下的格子，其余收纳进末尾 +N 胶囊
      var priority = ['speed', 'context', 'quota', 'month', 'cache', 'today'];
      var budget = freeWidth - 36; // 预留给 "+N" 溢出胶囊
      var picked = Object.create(null);
      var used = 0;
      for (var i = 0; i < priority.length; i++) {
        var key = priority[i];
        if (enabledTabs.indexOf(key) < 0) continue;
        var need = (compactW[key] || 54) + (used > 0 ? sepW : 0);
        if (used + need <= budget) {
          picked[key] = true;
          used += need;
        }
      }
      var shown = [];
      var hidden = [];
      for (var j = 0; j < enabledTabs.length; j++) {
        if (picked[enabledTabs[j]]) shown.push(enabledTabs[j]);
        else hidden.push(enabledTabs[j]);
      }
      if (shown.length === 0) {
        return { density: 'mini', shown: [], hidden: enabledTabs.slice() };
      }
      return { density: 'tight', shown: shown, hidden: hidden };
    }

    function buildSparkleIcon(cls, dual) {
      if (dual) {
        return '<svg class="tm-star tm-star-dual ' + cls + '" viewBox="0 0 24 24" aria-hidden="true">' +
          '<defs>' +
            '<linearGradient id="tm-gem-dual" x1="2" y1="2" x2="21" y2="22" gradientUnits="userSpaceOnUse">' +
              '<stop offset="0%" stop-color="var(--tm-gem-a)"/>' +
              '<stop offset="52%" stop-color="var(--tm-gem-b)"/>' +
              '<stop offset="100%" stop-color="var(--tm-gem-c)"/>' +
            '</linearGradient>' +
          '</defs>' +
          '<path class="tm-star-main" d="M10.2 3.2 C11.3 9.4 13.4 11.5 19.6 12.6 C13.4 13.7 11.3 15.8 10.2 22 C9.1 15.8 7 13.7 0.8 12.6 C7 11.5 9.1 9.4 10.2 3.2 Z"/>' +
          '<path class="tm-star-sub" d="M19.4 2.4 C19.9 4.5 20.6 5.2 22.7 5.7 C20.6 6.2 19.9 6.9 19.4 9 C18.9 6.9 18.2 6.2 16.1 5.7 C18.2 5.2 18.9 4.5 19.4 2.4 Z"/>' +
        '</svg>';
      }
      return '<svg class="tm-star ' + cls + '" viewBox="0 0 24 24" aria-hidden="true">' +
        '<defs>' +
          '<linearGradient id="tm-gem-bar" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">' +
            '<stop offset="0%" stop-color="var(--tm-gem-a)"/>' +
            '<stop offset="52%" stop-color="var(--tm-gem-b)"/>' +
            '<stop offset="100%" stop-color="var(--tm-gem-c)"/>' +
          '</linearGradient>' +
        '</defs>' +
        '<path class="tm-star-main" d="M12 1.2 C13.2 8.2 15.8 10.8 22.8 12 C15.8 13.2 13.2 15.8 12 22.8 C10.8 15.8 8.2 13.2 1.2 12 C8.2 10.8 10.8 8.2 12 1.2 Z"/>' +
      '</svg>';
    }

    var CTX_RING_R = 5.6;
    var CTX_RING_CIRC = 2 * Math.PI * CTX_RING_R;
    // 参考 Codex 的五段丰富连续色阶：翠绿 -> 天蓝 -> 琥珀金 -> 70% 明显朱红 -> 85% 鲜红 -> 爆满全红
    var CTX_COLOR_STOPS = [
      [0.00, 16, 185, 129],
      [0.32, 14, 165, 233],
      [0.52, 245, 158, 11],
      [0.68, 242, 82, 46],
      [0.82, 239, 68, 68],
      [0.95, 220, 38, 38],
      [1.00, 185, 28, 28],
    ];

    function buildContextBarFillStyle(frac) {
      var f = Math.max(0, Math.min(1, Number(frac) || 0));
      var pct = Math.round(f * 100);
      if (f >= 0.90) {
        return 'width:' + pct + '%;background:linear-gradient(90deg,#ef4444 0%,#dc2626 55%,#b91c1c 100%);';
      }
      var bgScale = (100 / Math.max(0.05, f)).toFixed(1) + '% 100%';
      return 'width:' + pct + '%;background:linear-gradient(90deg,#10b981 0%,#0ea5e9 34%,#f59e0b 54%,#f2522e 70%,#ef4444 85%,#dc2626 100%);background-size:' + bgScale + ';background-position:left center;';
    }

    function interpCtxColor(frac) {
      var f = Math.max(0, Math.min(1, Number(frac) || 0));
      for (var i = 0; i < CTX_COLOR_STOPS.length - 1; i++) {
        var a = CTX_COLOR_STOPS[i];
        var b = CTX_COLOR_STOPS[i + 1];
        if (f <= b[0]) {
          var k = (f - a[0]) / Math.max(1e-6, b[0] - a[0]);
          return 'rgb(' + Math.round(a[1] + (b[1] - a[1]) * k) + ',' + Math.round(a[2] + (b[2] - a[2]) * k) + ',' + Math.round(a[3] + (b[3] - a[3]) * k) + ')';
        }
      }
      return 'rgb(185,28,28)';
    }

    function buildContextRingSvg(frac, roleAttr) {
      var hasVal = typeof frac === 'number' && Number.isFinite(frac);
      var clamped = hasVal ? Math.max(0, Math.min(1, frac)) : 0;
      var dashOffset = CTX_RING_CIRC * (1 - clamped);
      var stroke = interpCtxColor(clamped);
      var attr = roleAttr ? ' data-tm-ring="' + roleAttr + '"' : '';
      return '<svg class="tm-ring" viewBox="0 0 16 16" aria-hidden="true"' + attr + '>' +
        '<circle cx="8" cy="8" r="' + CTX_RING_R + '" fill="none" stroke="var(--tm-ring-track)" stroke-width="1.85"/>' +
        '<circle class="tm-ring-val" cx="8" cy="8" r="' + CTX_RING_R + '" fill="none" stroke="' + stroke + '" stroke-width="1.85" stroke-linecap="round" stroke-dasharray="' + CTX_RING_CIRC.toFixed(3) + '" stroke-dashoffset="' + dashOffset.toFixed(3) + '" stroke-opacity="' + (clamped > 0 ? '1' : '0') + '" transform="rotate(-90 8 8)"/>' +
      '</svg>';
    }

    function syncContextRingEl(svgEl, frac) {
      if (!svgEl) return;
      var hasVal = typeof frac === 'number' && Number.isFinite(frac);
      var clamped = hasVal ? Math.max(0, Math.min(1, frac)) : 0;
      var dashOffset = CTX_RING_CIRC * (1 - clamped);
      var arc = svgEl.querySelector('.tm-ring-val');
      if (arc) {
        arc.setAttribute('stroke-dashoffset', dashOffset.toFixed(3));
        arc.setAttribute('stroke-opacity', clamped > 0 ? '1' : '0');
        arc.setAttribute('stroke', interpCtxColor(clamped));
      }
    }

    function buildSparklineSvg(points) {
      if (!Array.isArray(points) || points.length < 2) {
        return { html: '<div class="tm-empty">' + escapeHtml(t('noData')) + '</div>', meta: null };
      }
      var w = 276, h = 48, padX = 6, padY = 8;
      var vals = points.map(function(p) { var v = Number(p && p.tps); return Number.isFinite(v) && v >= 0 ? v : 0; });
      var min = Math.min.apply(null, vals);
      var max = Math.max.apply(null, vals);
      var span = Math.max(1, max - min);
      var pts = vals.map(function(v, idx) {
        return [
          padX + (idx / (vals.length - 1)) * (w - padX * 2),
          h - padY - ((v - min) / span) * (h - padY * 2)
        ];
      });
      var coords = pts.map(function(p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); });
      var area = padX + ',' + (h - 2) + ' ' + coords.join(' ') + ' ' + (w - padX) + ',' + (h - 2);
      var last = pts[pts.length - 1];
      var midY = (h / 2).toFixed(1);
      var items = points.map(function(p, idx) {
        return {
          idx: idx + 1,
          tps: vals[idx],
          ttft: p && p.ttft != null ? p.ttft : null,
          tokens: safeInt(p && p.tokens),
          x: pts[idx][0],
          y: pts[idx][1],
        };
      });
      var nodesHtml = items.map(function(it, idx) {
        if (idx === items.length - 1) return '';
        return '<circle class="tm-sp-node" cx="' + it.x.toFixed(1) + '" cy="' + it.y.toFixed(1) + '" r="2.2" fill="var(--tm-card)" stroke="currentColor" stroke-width="1.35" pointer-events="none"/>';
      }).join('');
      return {
        html: '<svg class="tm-spark tm-chart-interactive" id="tm-spark-svg" viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' +
          '<defs><linearGradient id="tm-sp-area" x1="0" y1="0" x2="0" y2="' + h + '" gradientUnits="userSpaceOnUse">' +
            '<stop offset="0%" stop-color="currentColor" stop-opacity="0.11"/>' +
            '<stop offset="100%" stop-color="currentColor" stop-opacity="0"/>' +
          '</linearGradient></defs>' +
          '<line x1="0" y1="' + midY + '" x2="' + w + '" y2="' + midY + '" stroke="var(--tm-hairline)" stroke-dasharray="2 3"/>' +
          '<polygon points="' + area + '" fill="url(#tm-sp-area)" pointer-events="none"/>' +
          '<polyline points="' + coords.join(' ') + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>' +
          nodesHtml +
          '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="5.2" fill="var(--tm-accent)" fill-opacity="0.16" pointer-events="none"/>' +
          '<circle id="tm-sp-last" cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.9" fill="var(--tm-accent)" stroke="var(--tm-card)" stroke-width="1.5" pointer-events="none"/>' +
          '<line id="tm-sp-xhair" x1="0" y1="2" x2="0" y2="' + (h - 2) + '" class="tm-sp-xhair" style="display:none"/>' +
          '<circle id="tm-sp-halo" cx="0" cy="0" r="6.5" fill="var(--tm-accent)" fill-opacity="0.22" pointer-events="none" style="display:none"/>' +
          '<circle id="tm-sp-dot" cx="0" cy="0" r="3.4" fill="var(--tm-card)" stroke="var(--tm-accent)" stroke-width="2.1" pointer-events="none" style="display:none"/>' +
          '<rect x="0" y="0" width="' + w + '" height="' + h + '" fill="transparent"/>' +
        '</svg>',
        meta: { kind: 'spark', w: w, padX: padX, items: items },
      };
    }

    function buildTokenBreakdownHtml(conv) {
      var tokens = conv && conv.tokens;
      var uIn = safeInt(tokens && tokens.uncachedInput);
      var cRead = safeInt(tokens && tokens.cacheRead);
      var rOut = safeInt(tokens && tokens.responseOutput);
      var tOut = safeInt(tokens && tokens.thinkingOutput);
      var sum = uIn + cRead + rOut + tOut;
      var wIn = sum > 0 ? (uIn / sum) * 100 : 0;
      var wCache = sum > 0 ? (cRead / sum) * 100 : 0;
      var wResp = sum > 0 ? (rOut / sum) * 100 : 0;
      var wThink = sum > 0 ? (tOut / sum) * 100 : 0;
      var fresh = getCacheFreshness(conv && conv.lastRequestTime);
      var thinkPct = conv && typeof conv.thinkingRatio === 'number' ? Math.round(conv.thinkingRatio * 100) + '%' : null;

      var metaLine = '';
      if (fresh || thinkPct || cRead > 0) {
        metaLine = '<div class="tm-micro-row">' +
          (fresh ? '<span class="tm-fresh ' + fresh.cls + '"><i></i>' + escapeHtml(fresh.label) + (cRead > 0 ? ' · ' + escapeHtml(t('cacheSaved')) + ' ' + escapeHtml(fmtTokens(cRead)) : '') + '</span>' : '<span></span>') +
          (thinkPct ? '<span class="tm-think-tag">' + escapeHtml(t('thinkShare')) + ' ' + escapeHtml(thinkPct) + '</span>' : '') +
        '</div>';
      }

      return metaLine +
        '<div class="tm-stack" aria-hidden="true">' +
          '<span class="tm-st-cache" style="width:' + wCache.toFixed(1) + '%"></span>' +
          '<span class="tm-st-in" style="width:' + wIn.toFixed(1) + '%"></span>' +
          '<span class="tm-st-resp" style="width:' + wResp.toFixed(1) + '%"></span>' +
          '<span class="tm-st-think" style="width:' + wThink.toFixed(1) + '%"></span>' +
        '</div>' +
        '<div class="tm-legend">' +
          '<div class="tm-leg-item"><span class="tm-leg-k"><i class="tm-sw tm-st-cache"></i>' + escapeHtml(t('cacheRead')) + '</span><span class="tm-leg-v">' + escapeHtml(fmtTokens(cRead)) + '</span></div>' +
          '<div class="tm-leg-item"><span class="tm-leg-k"><i class="tm-sw tm-st-in"></i>' + escapeHtml(t('uncachedIn')) + '</span><span class="tm-leg-v">' + escapeHtml(fmtTokens(uIn)) + '</span></div>' +
          '<div class="tm-leg-item"><span class="tm-leg-k"><i class="tm-sw tm-st-resp"></i>' + escapeHtml(t('responseOut')) + '</span><span class="tm-leg-v">' + escapeHtml(fmtTokens(rOut)) + '</span></div>' +
          '<div class="tm-leg-item"><span class="tm-leg-k"><i class="tm-sw tm-st-think"></i>' + escapeHtml(t('thinkingOut')) + '</span><span class="tm-leg-v">' + escapeHtml(fmtTokens(tOut)) + '</span></div>' +
        '</div>';
    }

    /* 双轨进度条 + 垂直时间基准节奏刻度线（Pace Tick） */
    function renderQuotaSubBar(tag, frac, resetIso, pacing) {
      var pct = Math.round(Math.max(0, Math.min(1, Number(frac) || 0)) * 100);
      var status = pacing && pacing.status;
      var cls = (pct <= 15 || status === 'burn') ? 'danger' : (pct <= 35 || status === 'fast') ? 'warn' : '';
      var tickHtml = '';
      if (pacing && typeof pacing.timeRemainingFraction === 'number' && Number.isFinite(pacing.timeRemainingFraction)) {
        var tickPos = Math.max(2, Math.min(98, Math.round(pacing.timeRemainingFraction * 100)));
        tickHtml = '<span class="tm-pace-tick" style="left:' + tickPos + '%" title="' + escapeHtml(t('paceLegend')) + '"></span>';
      }
      return '<div class="tm-qsub">' +
        '<span class="tm-qtag">' + escapeHtml(tag) + '</span>' +
        '<div class="tm-qtrack"><div class="tm-qbar"><div class="tm-qfill ' + cls + '" style="width:' + pct + '%"></div></div>' + tickHtml + '</div>' +
        '<span class="tm-qsub-val"><b>' + pct + '%</b><em>' + escapeHtml(fmtCountdown(resetIso)) + '</em></span>' +
      '</div>';
    }

    function buildDailyTrendSvg(days, todayDate) {
      var dayMap = Object.create(null);
      (days || []).forEach(function(d) {
        if (d && d.date) {
          dayMap[d.date] = { total: safeInt(d.total), requests: safeInt(d.requests) };
        }
      });
      var now = parseBaseDate(todayDate);
      var bars = [];
      var maxVal = 1;
      for (var i = 13; i >= 0; i--) {
        var dt = new Date(now);
        dt.setDate(dt.getDate() - i);
        var key = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
        var rec = dayMap[key];
        var v = rec ? rec.total : 0;
        var reqs = rec ? rec.requests : 0;
        if (v > maxVal) maxVal = v;
        bars.push({ key: key, val: v, reqs: reqs, isToday: todayDate ? key === todayDate : i === 0 });
      }
      var w = 278, h = 44, slot = w / bars.length, bw = Math.max(8, slot - 5);
      var metaItems = [];
      var rects = bars.map(function(b, idx) {
        var bh = b.val > 0 ? Math.max(4, Math.round((b.val / maxVal) * (h - 7))) : 2.5;
        var x = idx * slot + (slot - bw) / 2;
        var y = h - bh;
        var fill = b.val <= 0 ? 'var(--tm-elev)' : b.isToday ? 'var(--tm-accent)' : 'var(--tm-ink-bar)';
        var op = b.val <= 0 ? 1 : b.isToday ? 1 : (0.28 + 0.55 * (b.val / maxVal));
        metaItems.push({
          idx: idx,
          key: b.key,
          val: b.val,
          reqs: b.reqs,
          isToday: b.isToday,
          cx: idx * slot + slot / 2,
          topY: y,
        });
        return '<g class="tm-trend-col" data-t-idx="' + idx + '">' +
          '<rect class="tm-trend-hit" x="' + (idx * slot).toFixed(1) + '" y="0" width="' + slot.toFixed(1) + '" height="' + h + '" fill="transparent" data-t-idx="' + idx + '"/>' +
          '<rect class="tm-trend-bar' + (b.isToday ? ' is-today' : '') + (b.val <= 0 ? ' is-zero' : '') + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh + '" rx="2.2" fill="' + fill + '" fill-opacity="' + op.toFixed(2) + '" data-t-idx="' + idx + '"/>' +
        '</g>';
      }).join('');
      return {
        html: '<svg class="tm-trend tm-chart-interactive" id="tm-trend-svg" viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' +
          '<line x1="0" y1="' + (h - 0.5) + '" x2="' + w + '" y2="' + (h - 0.5) + '" stroke="var(--tm-hairline)"/>' +
          rects +
        '</svg>',
        meta: { kind: 'trend14', w: w, h: h, items: metaItems },
      };
    }

    function buildContextLargeRingSvg(frac) {
      var hasVal = typeof frac === 'number' && Number.isFinite(frac);
      var clamped = hasVal ? Math.max(0, Math.min(1, frac)) : 0;
      var r = 10.5;
      var circ = 2 * Math.PI * r;
      var offset = circ * (1 - clamped);
      var stroke = interpCtxColor(clamped);
      return '<svg class="tm-ring-lg" viewBox="0 0 26 26" aria-hidden="true">' +
        '<circle cx="13" cy="13" r="' + r + '" fill="none" stroke="var(--tm-ring-track)" stroke-width="2.4"/>' +
        '<circle cx="13" cy="13" r="' + r + '" fill="none" stroke="' + stroke + '" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="' + circ.toFixed(3) + '" stroke-dashoffset="' + offset.toFixed(3) + '" stroke-opacity="' + (clamped > 0 ? '1' : '0') + '" transform="rotate(-90 13 13)"/>' +
      '</svg>';
    }

    /**
     * 按当前悬停/固定激活的格子渲染独立精简卡片，做到“每一格只显示对应内容”。
     */
    function buildFocusedPopoverModel(tab, snap, conv, usage, quotas) {
      var modelLabel = (conv && conv.model) || (snap && snap.conversationUnavailable ? t('convUnavailable') : snap && snap.connected ? t('connected') : t('offline'));
      var isRunning = Boolean(conv && conv.running);

      if (tab === 'speed') {
        var heroNum = fmtFixed(conv && conv.latestTps, 1) || fmtFixed(conv && conv.tps, 1) || '--';
        var measuredText = conv ? (safeInt(conv.measuredRequests) + ' / ' + safeInt(conv.requests)) : '--';
        var streamFixed = conv && conv.streamingSeconds > 0 ? fmtFixed(conv.streamingSeconds, 1) : null;
        var streamText = streamFixed !== null ? streamFixed + 's' : '--';
        var sessionSpeedText = fmtFixed(conv && conv.tps, 1) || '--';
        var ttftFixed = fmtFixed(conv && conv.ttftSeconds, 2);
        var ttftText = ttftFixed !== null ? ttftFixed + 's' : '--';
        var sparkRes = buildSparklineSvg(conv && conv.sparkline);
        var costStr = conv && conv.costUsd != null ? fmtUsd(conv.costUsd) : null;
        var rateBadge = conv && conv.pricing
          ? '<span style="font-family:var(--tm-mono);font-size:9.5px;color:var(--tm-accent);margin-left:5px;" title="' + escapeHtml(t('pricingPer1M')) + '">$' + conv.pricing.inputPer1M + '/$' + conv.pricing.cacheReadPer1M + '/$' + conv.pricing.outputPer1M + '</span>'
          : '';
        return {
          title: t('cardSpeed'),
          badge: isRunning ? t('generating') : '',
          footCtx: modelLabel,
          chartMeta: sparkRes.meta,
          body:
            '<div class="tm-hero">' +
              '<div class="tm-hero-main"><span class="tm-hero-num">' + escapeHtml(heroNum) + '</span><span class="tm-hero-unit">' + escapeHtml(t('speedUnit')) + '</span>' + rateBadge + '</div>' +
              '<div class="tm-hero-meta">' + escapeHtml(t('streamTime')) + ' <b>' + escapeHtml(streamText) + '</b>' + (costStr ? '<br/><b style="color:var(--tm-cost,#059669)">' + escapeHtml(costStr) + '</b>' : '') + '</div>' +
            '</div>' +
            '<div class="tm-spark-wrap">' + sparkRes.html + '<div class="tm-mini-tip" id="tm-spark-tip" aria-hidden="true"></div></div>' +
            '<div class="tm-sub-strip tm-sub-strip-tight">' +
              '<div class="tm-sub-cell"><div class="tm-sub-k">' + escapeHtml(t('sessionSpeed')) + '</div><div class="tm-sub-v">' + escapeHtml(sessionSpeedText) + '</div></div>' +
              '<div class="tm-sub-cell"><div class="tm-sub-k">' + escapeHtml(t('ttft')) + '</div><div class="tm-sub-v">' + escapeHtml(ttftText) + '</div></div>' +
              '<div class="tm-sub-cell"><div class="tm-sub-k">' + escapeHtml(t('measuredReq')) + '</div><div class="tm-sub-v">' + escapeHtml(measuredText) + '</div></div>' +
            '</div>',
        };
      }

      if (tab === 'cache') {
        var cacheVal = conv && conv.cacheHitRate;
        var tokens = conv && conv.tokens;
        var inAll = safeInt(tokens && tokens.inputAll);
        var outAll = safeInt(tokens && tokens.output);
        return {
          title: t('cardCache'),
          badge: '',
          footCtx: modelLabel,
          body:
            '<div class="tm-hero">' +
              '<div class="tm-hero-main"><span class="tm-hero-num">' + escapeHtml(fmtPct(cacheVal)) + '</span><span class="tm-hero-unit">' + escapeHtml(t('cacheHit')) + '</span></div>' +
              '<div class="tm-hero-meta">' + escapeHtml(t('totalInput')) + ' <b>' + escapeHtml(fmtTokens(inAll)) + '</b><br/>' + escapeHtml(t('totalOutput')) + ' <b>' + escapeHtml(fmtTokens(outAll)) + '</b></div>' +
            '</div>' +
            (conv ? ('<div class="tm-sec tm-sec-flush">' + buildTokenBreakdownHtml(conv) + '</div>') : ('<div class="tm-empty">' + escapeHtml(t('noData')) + '</div>')),
        };
      }

      if (tab === 'context') {
        var ctx = conv && conv.context;
        var ctxFrac = ctx ? ctx.usedFraction : null;
        var ctxPct = typeof ctxFrac === 'number' && Number.isFinite(ctxFrac) ? Math.round(Math.max(0, Math.min(1, ctxFrac)) * 100) : 0;
        var isEnCtx = state.prefs && state.prefs.language === 'en';
        var turnsText = ctx && typeof ctx.estimatedTurnsLeft === 'number' && Number.isFinite(ctx.estimatedTurnsLeft)
          ? (isEnCtx ? (t('turnsLeft') + ctx.estimatedTurnsLeft + ' ' + t('turnsUnit')) : (t('turnsLeft') + ' ' + ctx.estimatedTurnsLeft + ' ' + t('turnsUnit')))
          : '';
        var ctxTone = ctxFrac >= 0.80 ? 'danger' : ctxFrac >= 0.60 ? 'high' : '';
        var ctxNoteText = ctxFrac >= 0.80 ? t('ctxHigh') : ctxFrac >= 0.60 ? t('ctxMid') : t('ctxHealthy');
        return {
          title: t('cardContext'),
          badge: '',
          footCtx: modelLabel,
          body: ctx ? (
            '<div class="tm-hero">' +
              '<div class="tm-hero-main tm-hero-ctx">' + buildContextLargeRingSvg(ctxFrac) + '<span class="tm-hero-num">' + escapeHtml(fmtPct(ctxFrac)) + '</span></div>' +
              '<div class="tm-hero-meta">' + (turnsText ? ('<b>' + escapeHtml(turnsText) + '</b><br/>') : '') + escapeHtml(fmtTokens(ctx.usedTokens) + ' / ' + fmtTokens(ctx.maxTokens)) + '</div>' +
            '</div>' +
            '<div class="tm-ctx-bar"><div class="tm-ctx-fill" style="' + buildContextBarFillStyle(ctxFrac) + '"></div></div>' +
            '<div class="tm-sub-strip tm-sub-strip-tight">' +
              '<div class="tm-sub-cell"><div class="tm-sub-k">' + escapeHtml(t('usedTokens')) + '</div><div class="tm-sub-v">' + escapeHtml(fmtTokens(ctx.usedTokens)) + '</div></div>' +
              '<div class="tm-sub-cell"><div class="tm-sub-k">' + escapeHtml(t('remaining')) + '</div><div class="tm-sub-v">' + escapeHtml(fmtTokens(ctx.remainingTokens)) + '</div></div>' +
              '<div class="tm-sub-cell"><div class="tm-sub-k">' + escapeHtml(t('windowCap')) + '</div><div class="tm-sub-v">' + escapeHtml(fmtTokens(ctx.maxTokens)) + '</div></div>' +
            '</div>' +
            '<div class="tm-ctx-note ' + ctxTone + '">' + escapeHtml(ctxNoteText) + '</div>'
          ) : ('<div class="tm-empty">' + escapeHtml(t('noData')) + '</div>'),
        };
      }

      if (tab === 'quota') {
        var qHtml = quotas.slice(0, 5).map(function(q) {
          if (q.fiveHour && q.weekly) {
            var worst = (q.fiveHour.pacing && q.fiveHour.pacing.status === 'burn') || (q.weekly.pacing && q.weekly.pacing.status === 'burn')
              ? 'burn'
              : (q.fiveHour.pacing && q.fiveHour.pacing.status === 'fast') || (q.weekly.pacing && q.weekly.pacing.status === 'fast')
                ? 'fast' : 'ok';
            var paceLabel = worst === 'burn' ? t('paceBurn') : worst === 'fast' ? t('paceFast') : t('paceOk');
            var pairHtml = escapeHtml(fmtPct(q.fiveHour.remainingFraction)) + '<span class="tm-slash">/</span>' + escapeHtml(fmtPct(q.weekly.remainingFraction));
            return '<div class="tm-qitem"><div class="tm-qmeta"><span class="tm-qname" title="' + escapeHtml(q.title) + '">' + escapeHtml(q.title) +
              '</span><span class="tm-qright"><span class="tm-pace-pill ' + worst + '">' + escapeHtml(paceLabel) + '</span><span class="tm-qpair" title="' + escapeHtml(t('quotaPairTip')) + '">' + pairHtml + '</span></span></div>' +
              renderQuotaSubBar(t('quotaTag5h'), q.fiveHour.remainingFraction, q.fiveHour.resetTime, q.fiveHour.pacing) +
              renderQuotaSubBar(t('quotaTagWeek'), q.weekly.remainingFraction, q.weekly.resetTime, q.weekly.pacing) +
            '</div>';
          }
          var kind = resolveQuotaKind(q);
          var tag = kind === '5h' ? t('quotaTag5h') : kind === 'week' ? t('quotaTagWeek') : '';
          return '<div class="tm-qitem"><div class="tm-qmeta"><span class="tm-qname" title="' + escapeHtml(q.title) + '">' + escapeHtml(q.title) + '</span></div>' +
            renderQuotaSubBar(tag || '·', q.remainingFraction, q.resetTime, q.pacing) + '</div>';
        }).join('');
        return {
          title: t('cardQuota'),
          badge: '',
          footCtx: t('quotaPairTip'),
          body: '<div class="tm-sec-title" style="margin-bottom:8px;"><span>' + escapeHtml(t('paceLegend')) + '</span><span>' + escapeHtml(t('quotaTag5h')) + ' / ' + escapeHtml(t('quotaTagWeek')) + '</span></div>' +
            (qHtml || '<div class="tm-empty">' + escapeHtml(t('noData')) + '</div>'),
        };
      }

      if (tab === 'today') {
        var u = usage || {};
        var tTotal = safeInt(u.todayTokens);
        var mTotal = safeInt(u.monthTokens);
        var shareText = mTotal > 0 ? Math.min(100, Math.round((tTotal / mTotal) * 100)) + '%' : '--';
        var modelsAll = Array.isArray(u.todayByModel) ? u.todayByModel : [];
        var models = modelsAll.slice(0, 4).map(function(m) { return { model: m.model, totalTokens: safeInt(m.totalTokens) }; });
        var shownSum = models.reduce(function(acc, m) { return acc + m.totalTokens; }, 0);
        if (tTotal > shownSum && models.length > 0) {
          models.push({ model: t('otherModels'), totalTokens: tTotal - shownSum });
        }
        var topMax = models.length ? Math.max(1, models[0].totalTokens) : 1;
        var modelBars = models.map(function(m) {
          var pct = Math.max(3, Math.round((safeInt(m.totalTokens) / topMax) * 100));
          return '<div class="tm-mbar-row">' +
            '<div class="tm-mbar-meta"><span class="tm-mbar-name" title="' + escapeHtml(m.model) + '">' + escapeHtml(m.model) + '</span><span class="tm-mbar-val">' + escapeHtml(fmtTokens(m.totalTokens)) + '</span></div>' +
            '<div class="tm-mbar-track"><div class="tm-mbar-fill" style="width:' + pct + '%"></div></div>' +
          '</div>';
        }).join('');
        var todayUsd = u.todayCostUsd != null ? fmtUsd(u.todayCostUsd) : null;
        return {
          title: t('cardToday'),
          badge: todayUsd || '',
          footCtx: u.todayDate || '',
          body:
            '<div class="tm-hero">' +
              '<div class="tm-hero-main"><span class="tm-hero-num">' + escapeHtml(fmtTokens(tTotal)) + '</span><span class="tm-hero-unit">tokens</span></div>' +
              '<div class="tm-hero-meta"><b>' + safeInt(u.todayRequests).toLocaleString() + '</b> ' + escapeHtml(t('requests')) + (todayUsd ? ' · <b style="color:var(--tm-cost,#059669)">' + escapeHtml(todayUsd) + '</b>' : '') + '<br/>' + escapeHtml(t('todayShare')) + ' <b>' + escapeHtml(shareText) + '</b></div>' +
            '</div>' +
            '<div class="tm-sub-strip">' +
              '<div class="tm-sub-cell"><div class="tm-sub-k">' + escapeHtml(t('uncachedIn')) + '</div><div class="tm-sub-v">' + escapeHtml(fmtTokens(u.todayInput)) + '</div></div>' +
              '<div class="tm-sub-cell"><div class="tm-sub-k">' + escapeHtml(t('cacheRead')) + '</div><div class="tm-sub-v">' + escapeHtml(fmtTokens(u.todayCacheRead)) + '</div></div>' +
              '<div class="tm-sub-cell"><div class="tm-sub-k">' + escapeHtml(t('totalOutput')) + '</div><div class="tm-sub-v">' + escapeHtml(fmtTokens(u.todayOutput)) + '</div></div>' +
            '</div>' +
            (modelBars ? ('<div class="tm-sec-title"><span>' + escapeHtml(t('todayModels')) + '</span></div><div class="tm-mbar-list">' + modelBars + '</div>') : ('<div class="tm-empty">' + escapeHtml(t('noData')) + '</div>')),
        };
      }

      if (tab === 'month') {
        var um = usage || {};
        var trendRes = buildDailyTrendSvg(um.days, um.todayDate);
        var monthUsd = um.monthCostUsd != null ? fmtUsd(um.monthCostUsd) : null;
        var totalUsd = um.totalCostUsd != null ? fmtUsd(um.totalCostUsd) : null;
        return {
          title: t('cardMonth'),
          badge: um.monthKey || '',
          footCtx: (safeInt(um.activeDays) > 0 ? (safeInt(um.activeDays) + ' ' + t('activeDays')) : ''),
          chartMeta: trendRes.meta,
          body:
            '<div class="tm-hero">' +
              '<div class="tm-hero-main"><span class="tm-hero-num">' + escapeHtml(fmtTokens(um.monthTokens)) + '</span><span class="tm-hero-unit">tokens</span></div>' +
              '<div class="tm-hero-meta"><b>' + safeInt(um.monthRequests).toLocaleString() + '</b> ' + escapeHtml(t('requests')) + (monthUsd ? ' · <b style="color:var(--tm-cost,#059669)">' + escapeHtml(monthUsd) + '</b>' : '') + '<br/>' + escapeHtml(t('lifetime')) + ' <b>' + escapeHtml(fmtTokens(um.totalTokens)) + '</b>' + (totalUsd ? ' · <b style="color:var(--tm-cost,#059669)">' + escapeHtml(totalUsd) + '</b>' : '') + '</div>' +
            '</div>' +
            '<div class="tm-sec-title" style="margin-bottom:4px;"><span>' + escapeHtml(t('dailyTrend')) + '</span><span class="tm-chart-readout" id="tm-trend-readout"></span></div>' +
            '<div class="tm-trend-wrap">' + trendRes.html + '<div class="tm-mini-tip" id="tm-trend-tip" aria-hidden="true"></div></div>' +
            '<div class="tm-sec" style="margin-top:8px;padding-top:8px;">' +
              '<div class="tm-usage-strip">' +
                '<div class="tm-usage-cell"><div class="tm-usage-k">' + escapeHtml(t('today')) + '</div><div class="tm-usage-v">' + escapeHtml(fmtTokens(um.todayTokens)) + '</div></div>' +
                '<div class="tm-usage-cell"><div class="tm-usage-k">' + escapeHtml(t('week')) + '</div><div class="tm-usage-v">' + escapeHtml(fmtTokens(um.weekTokens)) + '</div></div>' +
                '<div class="tm-usage-cell"><div class="tm-usage-k">' + escapeHtml(t('month')) + '</div><div class="tm-usage-v">' + escapeHtml(fmtTokens(um.monthTokens)) + '</div></div>' +
                '<div class="tm-usage-cell"><div class="tm-usage-k">' + escapeHtml(t('lifetime')) + '</div><div class="tm-usage-v">' + escapeHtml(fmtTokens(um.totalTokens)) + '</div></div>' +
              '</div>' +
              '<div class="tm-usage-sub"><span>' + escapeHtml(t('cacheRead')) + ' ' + escapeHtml(fmtTokens(um.monthCacheRead)) + '</span><span>' + escapeHtml(t('uncachedIn')) + ' ' + escapeHtml(fmtTokens(um.monthInput)) + '</span><span>' + escapeHtml(t('totalOutput')) + ' ' + escapeHtml(fmtTokens(um.monthOutput)) + '</span></div>' +
            '</div>',
        };
      }

      // 溢出收纳卡（narrow / mini 档悬停 +N 或 ✦ 时集中展示被收纳的指标）
      if (tab === 'more') {
        var hiddenList = (state.overflowTabs && state.overflowTabs.length) ? state.overflowTabs : ['speed', 'cache', 'context', 'quota', 'today', 'month'];
        var leadQ = (quotas && quotas[0]) || null;
        var qPartsMore = getQuotaPairParts(snap && snap.quotaPair, leadQ);
        var qValMore = qPartsMore.single !== undefined ? qPartsMore.single : (qPartsMore.left + '/' + qPartsMore.right);
        var metricRows = hiddenList.map(function(k) {
          var lbl = '', val = '--';
          if (k === 'speed') {
            lbl = t('cardSpeed');
            var spFixed = fmtFixed(conv && (conv.latestTps != null ? conv.latestTps : conv.tps), 1);
            val = spFixed !== null ? spFixed + ' ' + t('speedUnit') : '--';
          } else if (k === 'cache') {
            lbl = t('cacheHit');
            val = fmtPct(conv && conv.cacheHitRate);
          } else if (k === 'context') {
            lbl = t('context');
            val = conv && conv.context ? fmtPct(conv.context.usedFraction) : '--';
          } else if (k === 'quota') {
            lbl = t('quota');
            val = qValMore;
          } else if (k === 'today') {
            lbl = t('today');
            val = usage ? fmtTokens(usage.todayTokens) : '--';
          } else if (k === 'month') {
            lbl = t('month');
            val = usage ? fmtTokens(usage.monthTokens) : '--';
          }
          return '<div class="tm-more-row"><span class="tm-more-k">' + escapeHtml(lbl) + '</span><span class="tm-more-v">' + escapeHtml(val) + '</span></div>';
        }).join('');
        return {
          title: t('moreMetrics'),
          badge: isRunning ? t('generating') : '',
          footCtx: modelLabel,
          body: '<div class="tm-more-list">' + metricRows + '</div>',
        };
      }

      // 兜底（当用户隐藏全部单项仅剩品牌图标时）
      var ub = usage || {};
      return {
        title: t('brand'),
        badge: isRunning ? t('generating') : '',
        footCtx: modelLabel,
        body:
          '<div class="tm-usage-strip">' +
            '<div class="tm-usage-cell"><div class="tm-usage-k">' + escapeHtml(t('today')) + '</div><div class="tm-usage-v">' + escapeHtml(fmtTokens(ub.todayTokens)) + '</div></div>' +
            '<div class="tm-usage-cell"><div class="tm-usage-k">' + escapeHtml(t('week')) + '</div><div class="tm-usage-v">' + escapeHtml(fmtTokens(ub.weekTokens)) + '</div></div>' +
            '<div class="tm-usage-cell"><div class="tm-usage-k">' + escapeHtml(t('month')) + '</div><div class="tm-usage-v">' + escapeHtml(fmtTokens(ub.monthTokens)) + '</div></div>' +
            '<div class="tm-usage-cell"><div class="tm-usage-k">' + escapeHtml(t('lifetime')) + '</div><div class="tm-usage-v">' + escapeHtml(fmtTokens(ub.totalTokens)) + '</div></div>' +
          '</div>',
      };
    }

    function baseStyles() {
      return \`
        :host {
          --tm-card: #ffffff;
          --tm-elev: #f4f4f5;
          --tm-border: rgba(24,24,27,0.10);
          --tm-hairline: rgba(24,24,27,0.075);
          --tm-text: #18181b;
          --tm-sub: #52525b;
          --tm-muted: #71717a;
          --tm-faint: #a1a1aa;
          --tm-hover: rgba(24,24,27,0.055);
          --tm-sep: rgba(24,24,27,0.16);
          --tm-ring-track: rgba(24,24,27,0.13);
          --tm-accent: #2563eb;
          --tm-gem-a: #38bdf8;
          --tm-gem-b: #3b82f6;
          --tm-gem-c: #7c3aed;
          --tm-gem-glow: rgba(59, 130, 246, 0.34);
          --tm-ink-bar: #18181b;
          --tm-ok: #16a34a;
          --tm-warn: #d97706;
          --tm-danger: #dc2626;
          --tm-radius: 11px;
          --tm-blur: none;
          --tm-shadow: 0 18px 44px -12px rgba(24,24,27,0.16), 0 2px 6px rgba(24,24,27,0.06);
          --tm-mono: ui-monospace, "SFMono-Regular", "Cascadia Mono", "Consolas", monospace;
          --tm-font: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          font-family: var(--tm-font);
          font-size: 11.5px;
          color: var(--tm-text);
          display: block;
          -webkit-font-smoothing: antialiased;
        }
        :host([data-theme="dark"]) {
          --tm-card: #121214;
          --tm-elev: #1c1c20;
          --tm-border: rgba(255,255,255,0.09);
          --tm-hairline: rgba(255,255,255,0.065);
          --tm-text: #f4f4f5;
          --tm-sub: #a1a1aa;
          --tm-muted: #8a8a93;
          --tm-faint: #52525b;
          --tm-hover: rgba(255,255,255,0.075);
          --tm-sep: rgba(255,255,255,0.16);
          --tm-ring-track: rgba(255,255,255,0.15);
          --tm-accent: #60a5fa;
          --tm-gem-a: #67e8f9;
          --tm-gem-b: #60a5fa;
          --tm-gem-c: #a78bfa;
          --tm-gem-glow: rgba(96, 165, 250, 0.42);
          --tm-ink-bar: #e4e4e7;
          --tm-ok: #22c55e;
          --tm-warn: #f59e0b;
          --tm-danger: #ef4444;
          --tm-shadow: 0 22px 48px -12px rgba(0,0,0,0.68), 0 0 0 1px rgba(255,255,255,0.04) inset;
        }
        /* 主题 2：液态磨砂 Glass（macOS 原生毛玻璃 HUD 质感） */
        :host([data-style="glass"]) {
          --tm-card: rgba(255,255,255,0.78);
          --tm-elev: rgba(24,24,27,0.055);
          --tm-border: rgba(255,255,255,0.68);
          --tm-hairline: rgba(24,24,27,0.08);
          --tm-radius: 14px;
          --tm-blur: blur(22px) saturate(180%);
          --tm-shadow: 0 20px 50px -14px rgba(15,23,42,0.18), 0 0 0 1px rgba(15,23,42,0.08), inset 0 1px 0 rgba(255,255,255,0.85);
        }
        :host([data-theme="dark"][data-style="glass"]) {
          --tm-card: rgba(24,24,28,0.76);
          --tm-elev: rgba(255,255,255,0.075);
          --tm-border: rgba(255,255,255,0.14);
          --tm-hairline: rgba(255,255,255,0.08);
          --tm-shadow: 0 24px 56px -12px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.12);
        }
        /* 主题 3：极客终端 Mono（数字等宽精密仪器 + 经典翠绿磷光点缀，正文保留无衬线防中文退化宋体及排版跳动） */
        :host([data-style="mono"]) {
          --tm-cost: #059669;
          --tm-card: #f6f8f6;
          --tm-elev: #e9eee9;
          --tm-border: rgba(16,32,24,0.18);
          --tm-hairline: rgba(16,32,24,0.10);
          --tm-accent: #059669;
          --tm-gem-a: #34d399;
          --tm-gem-b: #10b981;
          --tm-gem-c: #059669;
          --tm-gem-glow: rgba(16, 185, 129, 0.36);
          --tm-ink-bar: #059669;
          --tm-radius: 5px;
          --tm-shadow: 0 14px 32px -10px rgba(16,32,24,0.16);
        }
        :host([data-theme="dark"][data-style="mono"]) {
          --tm-cost: #34d399;
          --tm-card: #0c100e;
          --tm-elev: #151d19;
          --tm-border: rgba(16,185,129,0.22);
          --tm-hairline: rgba(16,185,129,0.11);
          --tm-text: #e6f4ec;
          --tm-sub: #9eb7a9;
          --tm-muted: #6f8a7c;
          --tm-faint: #465d51;
          --tm-accent: #10b981;
          --tm-gem-a: #6ee7b7;
          --tm-gem-b: #34d399;
          --tm-gem-c: #10b981;
          --tm-gem-glow: rgba(52, 211, 153, 0.42);
          --tm-ink-bar: #10b981;
          --tm-shadow: 0 20px 44px -10px rgba(0,0,0,0.75);
        }

        @keyframes tm-star-turn {
          0% { transform: rotate(0deg) scale(0.96); }
          50% { transform: rotate(45deg) scale(1.06); }
          100% { transform: rotate(90deg) scale(0.96); }
        }
        @keyframes tm-star-blink {
          0%, 100% { opacity: 0.45; transform: scale(0.86); }
          50% { opacity: 1; transform: scale(1.1); }
        }
        .tm-bar-wrap { position: relative; display: flex; align-items: center; padding: 3px 6px 2px; user-select: none; }
        :host([data-placement="inline-footer"]) {
          display: inline-flex;
          align-items: center;
          flex-shrink: 0;
          height: 28px;
          margin-right: 6px;
        }
        :host([data-placement="inline-footer"]) .tm-bar-wrap {
          padding: 0 2px;
          height: 28px;
          display: inline-flex;
          align-items: center;
        }
        :host([data-placement="inline-footer"]) .tm-chips {
          flex-wrap: nowrap;
        }
        :host([data-density="compact"]) .tm-chip,
        :host([data-density="tight"]) .tm-chip {
          padding: 2px 4px;
          gap: 3.5px;
          font-size: 11px;
        }
        :host([data-density="compact"]) .tm-label,
        :host([data-density="tight"]) .tm-label {
          font-size: 10.5px;
        }
        :host([data-density="compact"]) .tm-sep,
        :host([data-density="tight"]) .tm-sep {
          margin: 0 1px;
        }
        .tm-chip-more { font-family: var(--tm-mono); font-size: 10.5px; color: var(--tm-sub); background: var(--tm-hover); padding: 1px 5px !important; }
        .tm-more-list { display: flex; flex-direction: column; gap: 2px; }
        .tm-more-row { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 2px; border-bottom: 1px solid var(--tm-hairline); font-size: 11.5px; }
        .tm-more-row:last-child { border-bottom: none; padding-bottom: 2px; }
        .tm-more-k { color: var(--tm-muted); }
        .tm-more-v { font-family: var(--tm-mono); font-weight: 600; color: var(--tm-text); font-variant-numeric: tabular-nums; }
        .tm-chips { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 1px; }
        .tm-chip { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 6px; border-radius: 5px; background: transparent; border: none; color: var(--tm-muted); cursor: pointer; transition: background .14s ease, color .14s ease; line-height: 1; font-size: 11.5px; font-variant-numeric: tabular-nums; font-family: inherit; }
        .tm-chip:hover, .tm-chip:focus-visible, .tm-chip.active { background: var(--tm-hover); color: var(--tm-text); outline: none; }
        .tm-sep { width: 1px; height: 9px; background: var(--tm-sep); margin: 0 2px; display: inline-block; flex-shrink: 0; pointer-events: none; }
        .tm-star { width: 15px; height: 15px; display: block; flex-shrink: 0; filter: drop-shadow(0 0 2.5px var(--tm-gem-glow)); transition: transform .22s ease, filter .22s ease; }
        :host([data-density="compact"]) .tm-star,
        :host([data-density="tight"]) .tm-star { width: 14px; height: 14px; }
        .tm-star-dual { width: 18px; height: 18px; }
        .tm-star .tm-star-main { fill: url(#tm-gem-bar); }
        .tm-star-dual .tm-star-main { fill: url(#tm-gem-dual); }
        .tm-star-dual .tm-star-sub { fill: var(--tm-gem-a); }
        .tm-star.off { opacity: 0.45; filter: none; }
        .tm-star:not(.tm-star-dual).live { animation: tm-star-turn 3.4s ease-in-out infinite; }
        .tm-star-dual.live .tm-star-main { transform-box: fill-box; transform-origin: center; animation: tm-star-turn 3.4s ease-in-out infinite; }
        .tm-star-dual.live .tm-star-sub { transform-box: fill-box; transform-origin: center; animation: tm-star-blink 2s ease-in-out infinite; }
        .tm-chip:hover .tm-star.idle, .tm-chip.active .tm-star.idle { transform: rotate(18deg) scale(1.06); filter: drop-shadow(0 0 4px var(--tm-gem-glow)); }
        @media (prefers-reduced-motion: reduce) {
          .tm-star:not(.tm-star-dual).live, .tm-star-dual.live .tm-star-main, .tm-star-dual.live .tm-star-sub { animation: none; }
        }
        .tm-ring { width: 13px; height: 13px; display: block; flex-shrink: 0; }
        .tm-ring-lg { width: 24px; height: 24px; display: block; flex-shrink: 0; }
        .tm-ring-val { transition: stroke-dashoffset .45s cubic-bezier(0.22, 1, 0.36, 1), stroke .45s ease, stroke-opacity .25s ease; }
        .tm-label { color: var(--tm-muted); font-size: 11px; font-weight: 400; letter-spacing: 0.01em; line-height: 1; }
        .tm-val { color: var(--tm-text); font-weight: 500; opacity: 0.9; letter-spacing: -0.01em; line-height: 1; }
        .tm-chip:hover .tm-val, .tm-chip.active .tm-val { opacity: 1; }
        .tm-slash { color: var(--tm-faint); margin: 0 1.5px; font-weight: 400; }
        .tm-unit { color: var(--tm-faint); font-size: 10.5px; margin-left: -2px; line-height: 1; }

        .tm-popover { position: fixed; z-index: 2147483600; width: min(320px, calc(100vw - 20px)); max-height: calc(100vh - 24px); overflow: auto; background: var(--tm-card); backdrop-filter: var(--tm-blur); -webkit-backdrop-filter: var(--tm-blur); border: 1px solid var(--tm-border); border-radius: var(--tm-radius); box-shadow: var(--tm-shadow); padding: 13px 14px 11px; box-sizing: border-box; display: none; }
        .tm-popover.open { display: block; }
        .tm-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-height: 22px; margin-bottom: 10px; }
        .tm-brand-row { display: inline-flex; align-items: center; gap: 6px; min-width: 0; height: 22px; }
        .tm-head-acts { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; height: 22px; }
        .tm-model { display: inline-flex; align-items: center; font-size: 12.5px; font-weight: 650; color: var(--tm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 125px; letter-spacing: -0.015em; line-height: 1; }
        .tm-status-tag { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 99px; background: var(--tm-hover); font-family: var(--tm-mono); font-size: 10px; color: var(--tm-accent); font-weight: 500; line-height: 1; flex-shrink: 0; }
        .tm-btn { display: inline-flex; align-items: center; justify-content: center; height: 22px; border: 1px solid var(--tm-border); background: transparent; color: var(--tm-sub); border-radius: 5px; padding: 0 7px; font-size: 10.5px; font-weight: 500; line-height: 1; cursor: pointer; font-family: inherit; transition: border-color .14s, color .14s, background .14s; }
        .tm-btn:hover, .tm-btn:focus-visible { border-color: var(--tm-text); color: var(--tm-text); background: var(--tm-hover); outline: none; }

        .tm-hero { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
        .tm-hero-main { display: inline-flex; align-items: baseline; gap: 4px; }
        .tm-hero-ctx { align-items: center; gap: 7px; }
        .tm-hero-num { font-size: 26px; font-weight: 650; line-height: 1; letter-spacing: -0.035em; font-variant-numeric: tabular-nums; color: var(--tm-text); }
        .tm-hero-unit { font-size: 11px; color: var(--tm-muted); font-weight: 500; }
        .tm-hero-meta { font-size: 10.5px; color: var(--tm-muted); text-align: right; font-variant-numeric: tabular-nums; line-height: 1.45; }
        .tm-hero-meta b { color: var(--tm-text); font-weight: 600; }
        .tm-spark-wrap, .tm-trend-wrap { position: relative; color: var(--tm-text); margin: 2px 0 9px; }
        .tm-spark, .tm-trend { display: block; overflow: visible; }
        .tm-chart-interactive { cursor: pointer; }
        .tm-chart-readout { font-family: var(--tm-mono); font-size: 10px; font-weight: 500; color: var(--tm-accent); min-height: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .tm-trend-bar { transition: fill .12s ease, fill-opacity .12s ease, opacity .12s ease, filter .12s ease; }
        .tm-trend.has-hover .tm-trend-bar { opacity: 0.32; }
        .tm-trend.has-hover .tm-trend-bar.active { opacity: 1; fill: var(--tm-accent); fill-opacity: 1; filter: drop-shadow(0 0 4px var(--tm-gem-glow)); }
        .tm-trend.has-hover .tm-trend-bar.is-zero.active { opacity: 1; fill: var(--tm-muted); fill-opacity: 0.65; filter: none; }
        .tm-sp-node { transition: opacity .12s ease; }
        .tm-spark.has-hover .tm-sp-node { opacity: 0.45; }
        .tm-sp-xhair { stroke: var(--tm-muted); stroke-width: 1; stroke-dasharray: 2.5 2.5; opacity: 0.7; pointer-events: none; }
        .tm-mini-tip { position: absolute; left: 0; top: 0; z-index: 20; pointer-events: none; background: var(--tm-card); border: 1px solid var(--tm-border); border-radius: 7px; box-shadow: 0 8px 20px -6px rgba(15,23,42,0.22), 0 1px 4px rgba(15,23,42,0.08); padding: 4px 8px; font-size: 10.5px; line-height: 1.35; color: var(--tm-text); white-space: nowrap; opacity: 0; transform: translate(-50%, calc(-100% - 6px)); transition: opacity .08s ease; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
        .tm-mini-tip.show { opacity: 1; }
        .tm-mini-tip-date { font-family: var(--tm-mono); font-size: 9.5px; color: var(--tm-muted); margin-right: 6px; }
        .tm-mini-tip-val { font-family: var(--tm-mono); font-weight: 600; color: var(--tm-text); font-variant-numeric: tabular-nums; }
        .tm-mini-tip-sub { font-family: var(--tm-mono); font-size: 9.5px; color: var(--tm-sub); margin-top: 1px; }
        .tm-sub-strip { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--tm-hairline); border-bottom: 1px solid var(--tm-hairline); padding: 7px 0; margin-bottom: 9px; }
        .tm-sub-strip-tight { margin-bottom: 0; border-bottom: none; padding-bottom: 1px; }
        .tm-sub-cell { padding: 0 8px; border-left: 1px solid var(--tm-hairline); }
        .tm-sub-cell:first-child { padding-left: 0; border-left: none; }
        .tm-sub-k { font-size: 10px; color: var(--tm-muted); margin-bottom: 2px; }
        .tm-sub-v { font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--tm-text); letter-spacing: -0.015em; }
        .tm-usage-strip { display: grid; grid-template-columns: repeat(4, 1fr); padding: 2px 0; }
        .tm-usage-cell { padding: 0 7px; border-left: 1px solid var(--tm-hairline); }
        .tm-usage-cell:first-child { padding-left: 0; border-left: none; }
        .tm-usage-k { font-size: 9.5px; color: var(--tm-muted); margin-bottom: 2px; }
        .tm-usage-v { font-family: var(--tm-mono); font-size: 11.5px; font-weight: 600; color: var(--tm-text); }
        .tm-usage-sub { margin-top: 7px; font-family: var(--tm-mono); font-size: 10px; color: var(--tm-muted); display: flex; justify-content: space-between; gap: 6px; flex-wrap: wrap; }
        .tm-ctx-bar { width: 100%; height: 6px; border-radius: 99px; background: var(--tm-elev); overflow: hidden; margin: 5px 0 9px; }
        .tm-ctx-fill { height: 100%; border-radius: 99px; transition: width .35s ease, background .35s ease; }
        .tm-ctx-note { font-size: 10.5px; color: var(--tm-muted); margin-top: 7px; }
        .tm-ctx-note.high { color: #f2522e; font-weight: 500; }
        .tm-ctx-note.danger { color: var(--tm-danger); font-weight: 600; }
        .tm-mbar-list { display: flex; flex-direction: column; gap: 6px; }
        .tm-mbar-row { display: flex; flex-direction: column; gap: 3px; }
        .tm-mbar-meta { display: flex; justify-content: space-between; align-items: baseline; font-size: 11px; gap: 8px; }
        .tm-mbar-name { color: var(--tm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tm-mbar-val { font-family: var(--tm-mono); font-size: 10.5px; color: var(--tm-sub); flex-shrink: 0; }
        .tm-mbar-track { width: 100%; height: 3px; border-radius: 99px; background: var(--tm-elev); overflow: hidden; }
        .tm-mbar-fill { height: 100%; border-radius: 99px; background: var(--tm-ink-bar); opacity: 0.72; }
        .tm-mbar-row:first-child .tm-mbar-fill { background: var(--tm-accent); opacity: 1; }
        .tm-sec-flush { margin-top: 8px; padding-top: 8px; }

        .tm-micro-row { display: flex; justify-content: space-between; align-items: center; gap: 6px; font-size: 10px; color: var(--tm-muted); margin-bottom: 5px; }
        .tm-fresh { display: inline-flex; align-items: center; gap: 4px; }
        .tm-fresh i { width: 5px; height: 5px; border-radius: 50%; display: inline-block; background: var(--tm-ok); }
        .tm-fresh.cool i { background: var(--tm-warn); }
        .tm-fresh.cold i { background: var(--tm-faint); }
        .tm-think-tag { font-family: var(--tm-mono); color: var(--tm-sub); }

        .tm-sec { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--tm-hairline); }
        .tm-sec-title { font-size: 10.5px; color: var(--tm-muted); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; font-weight: 500; gap: 6px; }
        .tm-stack { display: flex; height: 4px; border-radius: 99px; overflow: hidden; background: var(--tm-elev); gap: 1px; margin-bottom: 7px; }
        .tm-st-cache { background: var(--tm-text); opacity: 0.78; }
        .tm-st-in { background: var(--tm-accent); }
        .tm-st-resp { background: var(--tm-muted); opacity: 0.65; }
        .tm-st-think { background: var(--tm-faint); opacity: 0.55; }
        .tm-legend { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; font-size: 11px; }
        .tm-leg-item { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
        .tm-leg-k { display: inline-flex; align-items: center; gap: 5px; color: var(--tm-muted); }
        .tm-leg-v { font-family: var(--tm-mono); font-size: 10.5px; font-weight: 500; color: var(--tm-text); }
        .tm-sw { width: 6px; height: 6px; border-radius: 1.5px; display: inline-block; flex-shrink: 0; }

        .tm-qitem { margin-bottom: 9px; }
        .tm-qitem:last-child { margin-bottom: 0; }
        .tm-qmeta { display: flex; justify-content: space-between; align-items: baseline; font-size: 11px; margin-bottom: 4px; gap: 6px; }
        .tm-qname { color: var(--tm-text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tm-qright { display: inline-flex; align-items: baseline; gap: 6px; flex-shrink: 0; }
        .tm-pace-pill { font-size: 9.5px; font-weight: 500; color: var(--tm-muted); }
        .tm-pace-pill.fast { color: var(--tm-warn); }
        .tm-pace-pill.burn { color: var(--tm-danger); }
        .tm-qpair { font-family: var(--tm-mono); font-size: 11px; font-weight: 600; color: var(--tm-text); }
        .tm-qsub { display: flex; align-items: center; gap: 7px; margin-top: 4px; font-size: 10.5px; }
        .tm-qtag { min-width: 24px; flex-shrink: 0; font-size: 10px; color: var(--tm-muted); font-family: var(--tm-mono); white-space: nowrap; }
        .tm-qtrack { position: relative; flex: 1; height: 9px; display: flex; align-items: center; }
        .tm-qbar { width: 100%; height: 3.5px; border-radius: 99px; background: var(--tm-elev); overflow: hidden; }
        .tm-qfill { height: 100%; border-radius: 99px; background: var(--tm-ink-bar); }
        .tm-qfill.warn { background: var(--tm-warn); }
        .tm-qfill.danger { background: var(--tm-danger); }
        /* 节奏时间基准竖线：一眼对照“当前剩余额度 vs 窗口剩余时间” */
        .tm-pace-tick { position: absolute; top: 0; bottom: 0; width: 1.5px; background: var(--tm-text); opacity: 0.58; border-radius: 1px; pointer-events: none; transform: translateX(-50%); }
        .tm-qsub-val { font-family: var(--tm-mono); font-size: 10px; color: var(--tm-muted); white-space: nowrap; min-width: 78px; text-align: right; display: inline-flex; justify-content: flex-end; gap: 6px; }
        .tm-qsub-val b { color: var(--tm-text); font-weight: 500; }
        .tm-qsub-val em { font-style: normal; color: var(--tm-faint); }

        .tm-foot { margin-top: 11px; padding-top: 9px; border-top: 1px solid var(--tm-hairline); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
        .tm-foot-ctx { display: inline-flex; align-items: center; gap: 5px; font-family: var(--tm-mono); font-size: 10px; color: var(--tm-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tm-link { border: none; background: transparent; color: var(--tm-text); font-weight: 500; font-size: 11px; cursor: pointer; padding: 2px 0; font-family: inherit; flex-shrink: 0; transition: color .14s; }
        .tm-link:hover { color: var(--tm-accent); }
        .tm-empty { color: var(--tm-faint); font-size: 11px; text-align: center; padding: 10px 0; }
      \`;
    }

    function fmtShortDate(dateKey) {
      var parts = String(dateKey || '').split('-');
      if (parts.length !== 3) return String(dateKey || '');
      var m = Number(parts[1]), d = Number(parts[2]);
      if (state.prefs && state.prefs.language === 'en') {
        var mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return (mons[m - 1] || m) + ' ' + d;
      }
      return m + '月' + d + '日';
    }

    function fmtMonthTick(monthNum) {
      if (state.prefs && state.prefs.language === 'en') {
        return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][monthNum - 1] || '';
      }
      return monthNum + '月';
    }

    /**
     * Fritsch-Carlson 单调三次贝塞尔平滑路径：保证波峰自然柔和且绝不在零基线下方产生负过冲。
     */
    function buildMonotoneSplinePath(pts) {
      var n = pts.length;
      if (n === 0) return '';
      if (n === 1) return 'M ' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
      var dx = [], dy = [], m = [];
      for (var i = 0; i < n - 1; i++) {
        dx.push(pts[i + 1][0] - pts[i][0]);
        dy.push(pts[i + 1][1] - pts[i][1]);
        m.push(dx[i] === 0 ? 0 : dy[i] / dx[i]);
      }
      var tang = new Array(n);
      tang[0] = m[0];
      tang[n - 1] = m[n - 2];
      for (var j = 1; j < n - 1; j++) {
        if (m[j - 1] * m[j] <= 0) {
          tang[j] = 0;
        } else {
          var w1 = dx[j - 1] + 2 * dx[j];
          var w2 = 2 * dx[j - 1] + dx[j];
          tang[j] = (w1 + w2) / (w1 / m[j - 1] + w2 / m[j]);
        }
      }
      var d = 'M ' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
      for (var k = 0; k < n - 1; k++) {
        var step = dx[k] / 3;
        var cp1x = pts[k][0] + step;
        var cp1y = pts[k][1] + tang[k] * step;
        var cp2x = pts[k + 1][0] - step;
        var cp2y = pts[k + 1][1] - tang[k + 1] * step;
        d += ' C ' + cp1x.toFixed(1) + ',' + cp1y.toFixed(1) + ' ' + cp2x.toFixed(1) + ',' + cp2y.toFixed(1) + ' ' + pts[k + 1][0].toFixed(1) + ',' + pts[k + 1][1].toFixed(1);
      }
      return d;
    }

    function buildZActivitySvg(usage, mode) {
      var dayMap = Object.create(null);
      (usage.days || []).forEach(function(d) {
        if (d && d.date) dayMap[d.date] = safeInt(d.total);
      });
      var now = parseBaseDate(usage && usage.todayDate);
      var todayDow = now.getDay(); // 0=Sun..6=Sat

      if (mode === 'weekly') {
        var weeks = [];
        var maxW = 1;
        for (var wk = 25; wk >= 0; wk--) {
          var sumW = 0;
          var startKey = '', endKey = '';
          for (var r = 6; r >= 0; r--) {
            var dt = new Date(now);
            dt.setDate(dt.getDate() - (wk * 7 + r));
            var k = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
            if (r === 6) startKey = k;
            if (r === 0) endKey = k;
            sumW += dayMap[k] || 0;
          }
          if (sumW > maxW) maxW = sumW;
          weeks.push({ startKey: startKey, endKey: endKey, val: sumW, month: Number(endKey.split('-')[1]) });
        }
        var ww = 725, wh = 114, padB = 18, slot = ww / weeks.length, bw = Math.max(12, slot - 7);
        var lastLblX = -50;
        var wBars = weeks.map(function(item, idx) {
          var x = idx * slot + (slot - bw) / 2;
          var barH = item.val > 0 ? Math.max(5, Math.round((item.val / maxW) * (wh - padB - 10))) : 3;
          var y = wh - padB - barH;
          var cls = item.val <= 0 ? 'tm-zc-0' : item.val > maxW * 0.7 ? 'tm-zc-4' : item.val > maxW * 0.4 ? 'tm-zc-3' : item.val > maxW * 0.15 ? 'tm-zc-2' : 'tm-zc-1';
          var lbl = '';
          if ((idx === 0 || weeks[idx - 1].month !== item.month) && x - lastLblX >= 40) {
            lastLblX = x;
            lbl = '<text x="' + x.toFixed(1) + '" y="' + (wh - 2) + '" class="tm-z-ax">' + escapeHtml(fmtMonthTick(item.month)) + '</text>';
          }
          return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + barH + '" rx="3.5" class="tm-z-wbar ' + cls + '" data-z-title="' + escapeHtml(item.startKey + ' ~ ' + item.endKey) + '" data-z-val="' + escapeHtml(fmtStatsTokens(item.val) + ' ' + t('tokensUnit')) + '"/>' + lbl;
        }).join('');
        return {
          html: '<svg class="tm-z-svg" id="tm-zact-svg" viewBox="0 0 ' + ww + ' ' + wh + '" width="100%" preserveAspectRatio="xMidYMid meet">' + wBars + '</svg>',
          meta: { kind: 'weekly' },
        };
      }

      if (mode === 'cumulative') {
        var spanDays = 90;
        var cumPts = [];
        var running = 0;
        var baseDays = (usage.days || []).slice().sort(function(a, b) { return String(a.date).localeCompare(String(b.date)); });
        var startDate = new Date(now);
        startDate.setDate(startDate.getDate() - (spanDays - 1));
        var startIso = startDate.getFullYear() + '-' + String(startDate.getMonth() + 1).padStart(2, '0') + '-' + String(startDate.getDate()).padStart(2, '0');
        baseDays.forEach(function(d) {
          if (d && d.date && d.date < startIso) running += safeInt(d.total);
        });
        var series = [];
        for (var ci = spanDays - 1; ci >= 0; ci--) {
          var cd = new Date(now);
          cd.setDate(cd.getDate() - ci);
          var ck = cd.getFullYear() + '-' + String(cd.getMonth() + 1).padStart(2, '0') + '-' + String(cd.getDate()).padStart(2, '0');
          var delta = dayMap[ck] || 0;
          running += delta;
          series.push({ key: ck, delta: delta, val: running, month: cd.getMonth() + 1 });
        }
        var cw = 725, ch = 114, padL = 52, padR = 12, padT = 8, padB2 = 18;
        var rawMaxC = series.length ? series[series.length - 1].val : 0;
        var maxC = Math.max(1, rawMaxC);
        var topTickText = rawMaxC > 0 ? fmtStatsTokens(rawMaxC) : '0';
        for (var si = 0; si < series.length; si++) {
          var px = padL + (si / Math.max(1, series.length - 1)) * (cw - padL - padR);
          var py = rawMaxC > 0 ? (padT + (1 - series[si].val / maxC) * (ch - padT - padB2)) : (ch - padB2);
          cumPts.push([px, py]);
        }
        var linePath = buildMonotoneSplinePath(cumPts);
        var baseY = ch - padB2;
        var areaPath = linePath + ' L ' + (cw - padR).toFixed(1) + ',' + baseY + ' L ' + padL + ',' + baseY + ' Z';
        var cLabels = '';
        var prevX = -60;
        for (var li = 0; li < series.length; li++) {
          if (li === 0 || series[li].month !== series[li - 1].month) {
            var lx = cumPts[li][0];
            if (lx - prevX >= 55) {
              prevX = lx;
              cLabels += '<text x="' + lx.toFixed(1) + '" y="' + (ch - 2) + '" class="tm-z-ax">' + escapeHtml(fmtMonthTick(series[li].month)) + '</text>';
            }
          }
        }
        return {
          html: '<svg class="tm-z-svg tm-z-interactive" id="tm-zcum-svg" viewBox="0 0 ' + cw + ' ' + ch + '" width="100%" preserveAspectRatio="xMidYMid meet">' +
            '<defs><linearGradient id="tm-zcum-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--tm-z-blue)" stop-opacity="0.22"/><stop offset="100%" stop-color="var(--tm-z-blue)" stop-opacity="0.01"/></linearGradient></defs>' +
            '<line x1="' + padL + '" y1="' + baseY + '" x2="' + (cw - padR) + '" y2="' + baseY + '" stroke="var(--tm-hairline)"/>' +
            '<text x="' + (padL - 6) + '" y="' + (padT + 6) + '" text-anchor="end" class="tm-z-ax">' + escapeHtml(topTickText) + '</text>' +
            '<text x="' + (padL - 6) + '" y="' + (baseY + 2) + '" text-anchor="end" class="tm-z-ax">0</text>' +
            '<path d="' + areaPath + '" fill="url(#tm-zcum-grad)" pointer-events="none"/>' +
            '<path d="' + linePath + '" fill="none" stroke="var(--tm-z-blue)" stroke-width="2" stroke-linecap="round" pointer-events="none"/>' +
            '<line id="tm-zcum-xhair" x1="0" y1="' + padT + '" x2="0" y2="' + baseY + '" class="tm-z-xhair" style="display:none"/>' +
            '<circle id="tm-zcum-halo" cx="0" cy="0" r="7.5" fill="var(--tm-z-blue)" fill-opacity="0.18" pointer-events="none" style="display:none"/>' +
            '<circle id="tm-zcum-dot" cx="0" cy="0" r="3.8" fill="var(--tm-card)" stroke="var(--tm-z-blue)" stroke-width="2.2" pointer-events="none" style="display:none"/>' +
            '<rect x="' + padL + '" y="' + padT + '" width="' + (cw - padL - padR) + '" height="' + (baseY - padT) + '" fill="transparent"/>' +
            cLabels +
          '</svg>',
          meta: { kind: 'cumulative', cw: cw, padL: padL, padR: padR, series: series, pts: cumPts },
        };
      }

      // 默认：52 周 1:1 标准正方形圆角日历热力图 + 底部月份刻度（仿 ZCode 布局）
      var totalCols = 52;
      var cellSize = 11;
      var gap = 3;
      var step = cellSize + gap; // 14
      var svgW = totalCols * step - gap; // 725
      var gridH = 7 * step - gap; // 95
      var svgH = gridH + 19; // 114
      var cells = [];
      var maxVal = 1;

      for (var col = 0; col < totalCols; col++) {
        var colCells = [];
        var colMonth = 0;
        for (var row = 0; row < 7; row++) {
          var offsetDays = (totalCols - 1 - col) * 7 + (todayDow - row);
          if (offsetDays < 0) {
            colCells.push(null);
            continue;
          }
          var dObj = new Date(now);
          dObj.setDate(dObj.getDate() - offsetDays);
          var dk = dObj.getFullYear() + '-' + String(dObj.getMonth() + 1).padStart(2, '0') + '-' + String(dObj.getDate()).padStart(2, '0');
          var dv = dayMap[dk] || 0;
          if (dv > maxVal) maxVal = dv;
          if (row === 0 || colMonth === 0) colMonth = dObj.getMonth() + 1;
          colCells.push({ key: dk, val: dv, x: col * step, y: row * step });
        }
        cells.push({ col: col, month: colMonth, items: colCells });
      }

      var rectsHtml = '';
      var monthLabelsHtml = '';
      var lastMonth = -1;
      var lastLabelX = -48;
      for (var c = 0; c < cells.length; c++) {
        var colObj = cells[c];
        var cx = colObj.col * step;
        if (colObj.month !== lastMonth) {
          lastMonth = colObj.month;
          if (cx - lastLabelX >= 36 && cx <= svgW - 22) {
            lastLabelX = cx;
            monthLabelsHtml += '<text x="' + cx + '" y="' + (gridH + 15) + '" class="tm-z-ax">' + escapeHtml(fmtMonthTick(colObj.month)) + '</text>';
          }
        }
        for (var rr = 0; rr < colObj.items.length; rr++) {
          var item = colObj.items[rr];
          if (!item) continue;
          var lvl = item.val <= 0 ? 'tm-zc-0' : item.val > maxVal * 0.72 ? 'tm-zc-4' : item.val > maxVal * 0.40 ? 'tm-zc-3' : item.val > maxVal * 0.14 ? 'tm-zc-2' : 'tm-zc-1';
          rectsHtml += '<rect x="' + item.x + '" y="' + item.y + '" width="' + cellSize + '" height="' + cellSize + '" rx="2.6" class="tm-z-hcell ' + lvl + '" data-z-title="' + escapeHtml(item.key) + '" data-z-val="' + escapeHtml(fmtStatsTokens(item.val) + ' ' + t('tokensUnit')) + '"/>';
        }
      }

      return {
        html: '<svg class="tm-z-svg" id="tm-zact-svg" viewBox="0 0 ' + svgW + ' ' + svgH + '" width="100%" preserveAspectRatio="xMidYMid meet">' + rectsHtml + monthLabelsHtml + '</svg>',
        meta: { kind: 'daily' },
      };
    }

    var Z_PALETTE = ['#2563eb', '#0ea5e9', '#6366f1', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];

    /**
     * 按选定时间范围（7 天 / 30 天）统计该时间段内各模型的累计 Token 与占比，供多模型趋势图与圆环图共用。
     */
    function computeRangeModelBreakdown(usage, rangeDays) {
      var daysObj = Object.create(null);
      (usage.days || []).forEach(function(d) {
        if (d && d.date) daysObj[d.date] = d;
      });
      var now = parseBaseDate(usage && usage.todayDate);
      var dateKeys = [];
      var modelTotals = Object.create(null);
      var rangeTotal = 0;
      var rangeRequests = 0;

      for (var i = rangeDays - 1; i >= 0; i--) {
        var dt = new Date(now);
        dt.setDate(dt.getDate() - i);
        var key = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
        dateKeys.push(key);
        var rec = daysObj[key];
        if (rec) {
          rangeTotal += safeInt(rec.total);
          rangeRequests += safeInt(rec.requests);
          if (rec.byModel && typeof rec.byModel === 'object') {
            Object.keys(rec.byModel).forEach(function(m) {
              var v = safeInt(rec.byModel[m]);
              if (v > 0) modelTotals[m] = (modelTotals[m] || 0) + v;
            });
          }
        }
      }

      // 附带全局均速与请求数索引
      var rankMeta = Object.create(null);
      (usage.modelRank || []).forEach(function(r) {
        if (r && r.model) rankMeta[r.model] = r;
      });

      var ranked = Object.keys(modelTotals)
        .map(function(m) {
          var meta = rankMeta[m] || null;
          return {
            model: m,
            totalTokens: modelTotals[m],
            avgTps: meta ? meta.avgTps : null,
            requests: meta ? safeInt(meta.requests) : 0,
          };
        })
        .sort(function(a, b) { return b.totalTokens - a.totalTokens; });

      // 仅当该时间范围确实有消费但旧账本缺少 byModel 细分时回退；若本时间段本就为 0 则诚实显示无数据，不误展全历史
      if (ranked.length === 0 && rangeTotal > 0 && Array.isArray(usage.modelRank) && usage.modelRank.length > 0) {
        ranked = usage.modelRank.slice(0, 8).map(function(m) {
          return { model: m.model, totalTokens: safeInt(m.totalTokens), avgTps: m.avgTps, requests: safeInt(m.requests) };
        });
      }

      // 判断 Top 5 之外是否还存在长尾模型（供趋势图与图例栏保持一致）
      var top5 = ranked.slice(0, 5);
      var hasOtherInRange = false;
      for (var di = 0; di < dateKeys.length; di++) {
        var rDay = daysObj[dateKeys[di]];
        if (!rDay) continue;
        var sumTop5 = 0;
        for (var ti = 0; ti < top5.length; ti++) {
          var mn = top5[ti].model;
          if (rDay.byModel && Object.hasOwn(rDay.byModel, mn)) sumTop5 += safeInt(rDay.byModel[mn]);
        }
        if (safeInt(rDay.total) - sumTop5 > 0) {
          hasOtherInRange = true;
          break;
        }
      }

      return {
        dateKeys: dateKeys,
        daysObj: daysObj,
        ranked: ranked,
        rangeTotal: rangeTotal,
        rangeRequests: rangeRequests,
        hasOtherInRange: hasOtherInRange,
      };
    }

    /**
     * 原创纯 SVG Donut 圆环图（内径 56% / 外径 86%，扇区留白间隙 + 中心居中总 Token 读数）。
     */
    function buildZModelDonutHtml(usage, rangeDays) {
      var info = computeRangeModelBreakdown(usage, rangeDays);
      var ranked = info.ranked;
      if (!ranked.length) {
        return { html: '<div class="tm-empty">' + escapeHtml(t('noData')) + '</div>', meta: null };
      }

      var maxSlices = 5;
      var slices = [];
      var otherSum = 0;
      for (var i = 0; i < ranked.length; i++) {
        if (i < maxSlices) {
          slices.push({
            label: ranked[i].model,
            totalTokens: ranked[i].totalTokens,
            avgTps: ranked[i].avgTps,
            color: Z_PALETTE[i % Z_PALETTE.length],
          });
        } else {
          otherSum += ranked[i].totalTokens;
        }
      }
      if (otherSum > 0) {
        slices.push({
          label: t('otherModels'),
          totalTokens: otherSum,
          avgTps: null,
          color: '#94a3b8',
        });
      }

      var total = slices.reduce(function(acc, s) { return acc + s.totalTokens; }, 0);
      if (total <= 0) return { html: '<div class="tm-empty">' + escapeHtml(t('noData')) + '</div>', meta: null };

      var cx = 104, cy = 104, rOuter = 88, rInner = 56;
      var startAngle = -Math.PI / 2;
      var pathsHtml = '';
      var sliceMeta = [];

      if (slices.length === 1) {
        sliceMeta.push({ label: slices[0].label, valText: fmtStatsTokens(slices[0].totalTokens), pctText: '100%', color: slices[0].color, avgTps: slices[0].avgTps });
        pathsHtml = '<circle cx="' + cx + '" cy="' + cy + '" r="' + ((rOuter + rInner) / 2).toFixed(1) + '" fill="none" stroke="' + slices[0].color + '" stroke-width="' + (rOuter - rInner) + '" class="tm-z-slice" data-z-slice="0"/>';
      } else {
        // 先保护极小扇区最小弧度，再将超出 2π 的部分按可压缩余量从大扇区等比扣除，确保总弧度严格闭合于 2π 绝不越界覆盖
        var fullCircle = Math.PI * 2;
        var minSweep = Math.min(0.025, fullCircle / (slices.length * 4));
        var sweeps = slices.map(function(s) {
          return Math.max(minSweep, (s.totalTokens / total) * fullCircle);
        });
        var excess = sweeps.reduce(function(acc, v) { return acc + v; }, 0) - fullCircle;
        if (excess > 1e-6) {
          var slackTotal = sweeps.reduce(function(acc, v) { return acc + Math.max(0, v - minSweep); }, 0);
          if (slackTotal > 1e-6) {
            for (var k = 0; k < sweeps.length; k++) {
              var slack = Math.max(0, sweeps[k] - minSweep);
              sweeps[k] -= excess * (slack / slackTotal);
            }
          }
        }
        for (var si = 0; si < slices.length; si++) {
          var s = slices[si];
          var frac = s.totalTokens / total;
          var sweep = sweeps[si];
          var endAngle = si === slices.length - 1 ? (-Math.PI / 2 + fullCircle) : (startAngle + sweep);
          var largeArc = sweep > Math.PI ? 1 : 0;
          var x1 = cx + rOuter * Math.cos(startAngle);
          var y1 = cy + rOuter * Math.sin(startAngle);
          var x2 = cx + rOuter * Math.cos(endAngle);
          var y2 = cy + rOuter * Math.sin(endAngle);
          var x3 = cx + rInner * Math.cos(endAngle);
          var y3 = cy + rInner * Math.sin(endAngle);
          var x4 = cx + rInner * Math.cos(startAngle);
          var y4 = cy + rInner * Math.sin(startAngle);
          var d = 'M ' + x1.toFixed(2) + ' ' + y1.toFixed(2) +
            ' A ' + rOuter + ' ' + rOuter + ' 0 ' + largeArc + ' 1 ' + x2.toFixed(2) + ' ' + y2.toFixed(2) +
            ' L ' + x3.toFixed(2) + ' ' + y3.toFixed(2) +
            ' A ' + rInner + ' ' + rInner + ' 0 ' + largeArc + ' 0 ' + x4.toFixed(2) + ' ' + y4.toFixed(2) + ' Z';
          var pctStr = frac >= 0.1 ? Math.round(frac * 100) + '%' : (frac * 100).toFixed(1) + '%';
          sliceMeta.push({ label: s.label, valText: fmtStatsTokens(s.totalTokens), pctText: pctStr, color: s.color, avgTps: s.avgTps });
          pathsHtml += '<path d="' + d + '" fill="' + s.color + '" stroke="var(--tm-z-donut-gap)" stroke-width="2.2" class="tm-z-slice" data-z-slice="' + si + '"/>';
          startAngle = endAngle;
        }
      }

      var totalText = fmtStatsTokens(total);
      var donutSvg =
        '<div class="tm-z-donut-box">' +
          '<svg class="tm-z-donut-svg" id="tm-zdonut-svg" viewBox="0 0 208 208" width="208" height="208">' + pathsHtml + '</svg>' +
          '<div class="tm-z-donut-center"><div class="tm-z-donut-val" id="tm-zdonut-val">' + escapeHtml(totalText) + '</div><div class="tm-z-donut-unit" id="tm-zdonut-unit">' + escapeHtml(t('tokensUnit')) + '</div></div>' +
        '</div>';

      var listHtml = '<div class="tm-z-pie-list" id="tm-zpie-list">' + slices.map(function(s, si) {
        var share = s.totalTokens / total;
        var pctLabel = share >= 0.1 ? Math.round(share * 100) + '%' : (share * 100).toFixed(1) + '%';
        var tpsFixed = fmtFixed(s.avgTps, 1);
        return '<div class="tm-z-pie-row" data-z-slice="' + si + '">' +
          '<span class="tm-z-pie-sw" style="background:' + s.color + '"></span>' +
          '<span class="tm-z-pie-name" title="' + escapeHtml(s.label) + '">' + escapeHtml(s.label) + '</span>' +
          '<span class="tm-z-pie-pct">' + escapeHtml(pctLabel) + '</span>' +
          '<span class="tm-z-pie-sub">' + escapeHtml(fmtStatsTokens(s.totalTokens)) + ' ' + escapeHtml(t('tokensUnit')) + (tpsFixed !== null ? ' · ' + tpsFixed + ' t/s' : '') + '</span>' +
        '</div>';
      }).join('') + '</div>';

      return {
        html: '<div class="tm-z-pie-grid">' + donutSvg + listHtml + '</div>',
        meta: { totalText: totalText, totalUnit: t('tokensUnit'), slices: sliceMeta },
      };
    }

    function buildZSmoothTrendSvg(usage, rangeDays, selectedModel) {
      var info = computeRangeModelBreakdown(usage, rangeDays);
      var dateKeys = info.dateKeys;
      var daysObj = info.daysObj;
      var topSeriesModels = info.ranked.slice(0, 5);

      var seriesList = [];
      if (selectedModel === '__OTHER__') {
        seriesList.push({
          label: t('otherModels'),
          color: '#94a3b8',
          values: dateKeys.map(function(k) {
            var rec = daysObj[k];
            if (!rec) return 0;
            var topSum = 0;
            for (var ti = 0; ti < topSeriesModels.length; ti++) {
              var mKey = topSeriesModels[ti].model;
              if (rec.byModel && Object.hasOwn(rec.byModel, mKey)) topSum += safeInt(rec.byModel[mKey]);
            }
            return Math.max(0, safeInt(rec.total) - topSum);
          }),
        });
      } else if (selectedModel && selectedModel !== 'ALL') {
        var idxFound = topSeriesModels.findIndex(function(x) { return x.model === selectedModel; });
        var color = Z_PALETTE[(idxFound >= 0 ? idxFound : 0) % Z_PALETTE.length];
        seriesList.push({
          label: selectedModel,
          color: color,
          values: dateKeys.map(function(k) {
            var rec = daysObj[k];
            return rec && rec.byModel && Object.hasOwn(rec.byModel, selectedModel) ? safeInt(rec.byModel[selectedModel]) : 0;
          }),
        });
      } else if (topSeriesModels.length > 0) {
        // 默认同屏多模型平滑曲线对比；若当日存在 Top 5 之外的长尾模型，自动聚合为「其他模型」确保合计与热力图 100% 严丝合缝
        var topSet = Object.create(null);
        for (var mi = 0; mi < topSeriesModels.length; mi++) {
          var mName = topSeriesModels[mi].model;
          topSet[mName] = true;
          seriesList.push({
            label: mName,
            color: Z_PALETTE[mi % Z_PALETTE.length],
            values: dateKeys.map(function(k) {
              var rec = daysObj[k];
              return rec && rec.byModel && Object.hasOwn(rec.byModel, mName) ? safeInt(rec.byModel[mName]) : 0;
            }),
          });
        }
        var otherValues = dateKeys.map(function(k, idx) {
          var rec = daysObj[k];
          if (!rec) return 0;
          var topSum = 0;
          for (var ti = 0; ti < seriesList.length; ti++) topSum += seriesList[ti].values[idx] || 0;
          return Math.max(0, safeInt(rec.total) - topSum);
        });
        if (otherValues.some(function(v) { return v > 0; })) {
          seriesList.push({
            label: t('otherModels'),
            color: '#94a3b8',
            values: otherValues,
          });
        }
      } else {
        seriesList.push({
          label: t('allModels'),
          color: Z_PALETTE[0],
          values: dateKeys.map(function(k) {
            var rec = daysObj[k];
            return rec ? safeInt(rec.total) : 0;
          }),
        });
      }

      var maxVal = 0;
      for (var si = 0; si < seriesList.length; si++) {
        for (var vi = 0; vi < seriesList[si].values.length; vi++) {
          if (seriesList[si].values[vi] > maxVal) maxVal = seriesList[si].values[vi];
        }
      }

      var w = 720, h = 198, padL = 52, padR = 24, padT = 14, padB = 26;
      var plotW = w - padL - padR;
      var plotH = h - padT - padB;
      var scaleMax = maxVal > 0 ? maxVal * 1.12 : 1000;

      var gridHtml = '';
      var steps = 3;
      for (var g = 0; g <= steps; g++) {
        var gy = padT + (g / steps) * plotH;
        var gVal = Math.round(scaleMax * (1 - g / steps));
        gridHtml += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (w - padR) + '" y2="' + gy.toFixed(1) + '" stroke="var(--tm-hairline)"' + (g < steps ? ' stroke-dasharray="3 3"' : '') + '/>';
        gridHtml += '<text x="' + (padL - 8) + '" y="' + (gy + 3.5).toFixed(1) + '" text-anchor="end" class="tm-z-ax">' + escapeHtml(g === steps ? '0' : fmtStatsTokens(gVal)) + '</text>';
      }

      var baseY = padT + plotH;
      var pathsHtml = '';
      var dotsHtml = '';
      var singleSeries = seriesList.length === 1;
      var seriesCoords = [];

      for (var sIdx = 0; sIdx < seriesList.length; sIdx++) {
        var ser = seriesList[sIdx];
        var coords = ser.values.map(function(v, idx) {
          var x = padL + (idx / Math.max(1, dateKeys.length - 1)) * plotW;
          var y = padT + (1 - v / scaleMax) * plotH;
          return [x, y];
        });
        seriesCoords.push(coords);
        var lineD = buildMonotoneSplinePath(coords);
        if (singleSeries) {
          var areaD = lineD + ' L ' + coords[coords.length - 1][0].toFixed(1) + ',' + baseY.toFixed(1) + ' L ' + coords[0][0].toFixed(1) + ',' + baseY.toFixed(1) + ' Z';
          pathsHtml += '<path d="' + areaD + '" fill="' + ser.color + '" fill-opacity="0.10" pointer-events="none"/>';
        }
        pathsHtml += '<path d="' + lineD + '" fill="none" stroke="' + ser.color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>';
        var rDot = rangeDays <= 7 ? 3 : 2.1;
        for (var pi = 0; pi < coords.length; pi++) {
          if (ser.values[pi] <= 0) continue;
          dotsHtml += '<circle cx="' + coords[pi][0].toFixed(1) + '" cy="' + coords[pi][1].toFixed(1) + '" r="' + rDot + '" fill="var(--tm-card)" stroke="' + ser.color + '" stroke-width="1.7" pointer-events="none"/>';
        }
      }

      var labelStride = rangeDays <= 7 ? 1 : 5;
      var xLabelsHtml = '';
      for (var xi = 0; xi < dateKeys.length; xi++) {
        var lx = padL + (xi / Math.max(1, dateKeys.length - 1)) * plotW;
        var isEdge = xi === 0 || xi === dateKeys.length - 1;
        if (isEdge || (xi % labelStride === 0 && (dateKeys.length - 1 - xi) >= Math.ceil(labelStride / 2))) {
          xLabelsHtml += '<text x="' + lx.toFixed(1) + '" y="' + (h - 6) + '" text-anchor="middle" class="tm-z-ax">' + escapeHtml(fmtShortDate(dateKeys[xi])) + '</text>';
        }
      }

      return {
        html: '<svg class="tm-z-svg tm-z-interactive" id="tm-ztrend-svg" viewBox="0 0 ' + w + ' ' + h + '" width="100%" preserveAspectRatio="xMidYMid meet">' +
          gridHtml + pathsHtml + dotsHtml +
          '<line id="tm-ztrend-xhair" x1="0" y1="' + padT + '" x2="0" y2="' + baseY + '" class="tm-z-xhair" style="display:none"/>' +
          '<g id="tm-ztrend-active" pointer-events="none"></g>' +
          '<rect x="' + padL + '" y="' + padT + '" width="' + plotW + '" height="' + plotH + '" fill="transparent"/>' +
          xLabelsHtml +
        '</svg>',
        meta: { w: w, padL: padL, plotW: plotW, dateKeys: dateKeys, seriesList: seriesList, seriesCoords: seriesCoords },
      };
    }

    function modalStyles() {
      return baseStyles() + \`
        :host {
          --tm-z-surface: #f5f6f8;
          --tm-z-donut-gap: #f5f6f8;
          --tm-z-pill-bg: #ebedf0;
          --tm-z-blue: #2563eb;
          --tm-zc-0: #e8eaee;
          --tm-zc-1: #dbeafe;
          --tm-zc-2: #93c5fd;
          --tm-zc-3: #3b82f6;
          --tm-zc-4: #1d4ed8;
        }
        :host([data-theme="dark"]) {
          --tm-z-surface: #18181c;
          --tm-z-donut-gap: #18181c;
          --tm-z-pill-bg: #232329;
          --tm-z-blue: #3b82f6;
          --tm-zc-0: #23252a;
          --tm-zc-1: rgba(59,130,246,0.22);
          --tm-zc-2: rgba(59,130,246,0.44);
          --tm-zc-3: rgba(59,130,246,0.72);
          --tm-zc-4: #60a5fa;
        }
        :host([data-style="glass"]) {
          --tm-z-surface: rgba(24,24,27,0.045);
          --tm-z-donut-gap: #f2f4f7;
          --tm-z-pill-bg: rgba(24,24,27,0.07);
        }
        :host([data-theme="dark"][data-style="glass"]) {
          --tm-z-surface: rgba(255,255,255,0.055);
          --tm-z-donut-gap: #1e2026;
          --tm-z-pill-bg: rgba(255,255,255,0.09);
        }
        :host([data-style="mono"]) {
          --tm-z-surface: #edf2ee;
          --tm-z-donut-gap: #edf2ee;
          --tm-z-pill-bg: #e1e8e2;
          --tm-z-blue: #059669;
          --tm-zc-0: #dce4de;
          --tm-zc-1: rgba(16,185,129,0.24);
          --tm-zc-2: rgba(16,185,129,0.46);
          --tm-zc-3: rgba(16,185,129,0.72);
          --tm-zc-4: #059669;
        }
        :host([data-theme="dark"][data-style="mono"]) {
          --tm-z-surface: #121915;
          --tm-z-donut-gap: #121915;
          --tm-z-pill-bg: #1a241f;
          --tm-z-blue: #10b981;
          --tm-zc-0: #1b241f;
          --tm-zc-4: #10b981;
        }
        .tm-backdrop { position: fixed; inset: 0; z-index: 2147483640; background: rgba(9,9,11,0.52); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; padding: 20px; }
        .tm-modal { width: min(820px, 94vw); max-height: 88vh; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; -ms-overflow-style: none; background: var(--tm-card); backdrop-filter: var(--tm-blur); -webkit-backdrop-filter: var(--tm-blur); border: 1px solid var(--tm-border); border-radius: 16px; box-shadow: var(--tm-shadow); padding: 24px 28px 22px; box-sizing: border-box; transition: background-color .22s ease, border-color .22s ease, box-shadow .22s ease; }
        .tm-modal::-webkit-scrollbar { display: none; width: 0; height: 0; }

        .tm-mhead { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; gap: 10px; }
        .tm-mtitle-wrap { display: inline-flex; align-items: center; gap: 10px; }
        .tm-mtitle { font-size: 20px; font-weight: 700; letter-spacing: -0.025em; color: var(--tm-text); line-height: 1.2; }
        .tm-mbadge { font-size: 11px; font-weight: 500; color: var(--tm-muted); background: var(--tm-z-surface); padding: 3px 10px; border-radius: 99px; }

        .tm-z-kpis { display: grid; grid-template-columns: repeat(5, 1fr); background: var(--tm-z-surface); border-radius: 14px; padding: 15px 6px; margin-bottom: 14px; }
        @media (max-width: 580px) {
          .tm-z-kpis { grid-template-columns: repeat(2, 1fr); gap: 10px 4px; }
          .tm-z-kpi { border-left: none; }
        }
        .tm-z-kpi { text-align: center; padding: 2px 8px; border-left: 1px solid var(--tm-hairline); min-width: 0; }
        .tm-z-kpi:first-child { border-left: none; }
        .tm-z-kpi-v { font-size: 18px; font-weight: 650; letter-spacing: -0.025em; font-variant-numeric: tabular-nums; color: var(--tm-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .tm-z-kpi-k { font-size: 11px; color: var(--tm-muted); margin-top: 4px; white-space: nowrap; }

        .tm-z-card { background: var(--tm-z-surface); border-radius: 14px; padding: 16px 18px; margin-bottom: 14px; }
        .tm-z-card:last-child { margin-bottom: 0; }
        .tm-z-card-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; }
        .tm-z-card-title { font-size: 13px; font-weight: 600; color: var(--tm-text); letter-spacing: -0.01em; }
        .tm-z-card-sub { font-size: 11px; color: var(--tm-muted); font-family: var(--tm-mono); }

        .tm-z-toolbar { display: flex; justify-content: space-between; align-items: center; margin: 16px 2px 10px; gap: 8px; }
        .tm-z-toolbar-label { font-size: 12px; color: var(--tm-muted); font-weight: 500; }
        .tm-z-seg { display: inline-flex; background: var(--tm-z-pill-bg); padding: 2.5px; border-radius: 999px; gap: 2px; }
        .tm-z-seg-btn { border: none; background: transparent; color: var(--tm-muted); font-size: 11.5px; font-weight: 500; padding: 3.5px 12px; border-radius: 999px; cursor: pointer; font-family: inherit; transition: all .14s ease; }
        .tm-z-seg-btn:hover { color: var(--tm-text); }
        .tm-z-seg-btn.active { background: var(--tm-card); color: var(--tm-text); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }

        .tm-z-svg { display: block; width: 100%; height: auto; overflow: visible; }
        .tm-z-ax { font-size: 10px; fill: var(--tm-muted); font-family: var(--tm-font); }
        .tm-zc-0 { fill: var(--tm-zc-0); }
        .tm-zc-1 { fill: var(--tm-zc-1); }
        .tm-zc-2 { fill: var(--tm-zc-2); }
        .tm-zc-3 { fill: var(--tm-zc-3); }
        .tm-zc-4 { fill: var(--tm-zc-4); }

        .tm-z-legends { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 10px; }
        .tm-z-leg { display: inline-flex; align-items: center; gap: 5px; border: 1px solid transparent; background: transparent; color: var(--tm-muted); font-size: 11px; padding: 3px 9px; border-radius: 99px; cursor: pointer; font-family: inherit; transition: all .14s; }
        .tm-z-leg:hover { color: var(--tm-text); background: var(--tm-hover); }
        .tm-z-leg.active { background: var(--tm-card); border-color: var(--tm-border); color: var(--tm-text); font-weight: 500; }
        .tm-z-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--tm-z-blue); }

        .tm-z-pie-grid { display: grid; grid-template-columns: minmax(180px, 230px) minmax(0, 1fr); gap: 20px; align-items: center; padding: 6px 4px 2px; }
        @media (max-width: 600px) { .tm-z-pie-grid { grid-template-columns: 1fr; } }
        .tm-z-donut-box { position: relative; width: 208px; height: 208px; margin: 0 auto; }
        .tm-z-donut-svg { display: block; width: 208px; height: 208px; }
        .tm-z-donut-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; text-align: center; padding: 0 24px; }
        .tm-z-donut-val { font-size: 16px; font-weight: 650; letter-spacing: -0.02em; color: var(--tm-text); font-variant-numeric: tabular-nums; }
        .tm-z-donut-unit { font-size: 11px; color: var(--tm-muted); margin-top: 2px; }
        .tm-z-pie-list { min-width: 0; }
        .tm-z-pie-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 2px 8px; padding: 7px 6px; margin: 0 -6px; border-radius: 8px; border-bottom: 1px solid var(--tm-hairline); transition: background .12s ease; cursor: default; }
        .tm-z-pie-row:last-child { border-bottom: none; }
        .tm-z-pie-row.active { background: var(--tm-hover); }
        .tm-z-pie-sw { width: 9px; height: 9px; border-radius: 2.5px; flex-shrink: 0; }
        .tm-z-pie-name { font-family: var(--tm-mono); font-size: 11.5px; color: var(--tm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tm-z-pie-pct { font-family: var(--tm-mono); font-size: 11.5px; color: var(--tm-muted); font-variant-numeric: tabular-nums; }
        .tm-z-pie-sub { grid-column: 2 / 4; font-size: 11px; color: var(--tm-muted); font-variant-numeric: tabular-nums; }

        /* 图表实时互动样式：准星、高亮方块/柱/扇区与 0ms 跟随浮卡 */
        .tm-z-interactive { cursor: crosshair; }
        .tm-z-xhair { stroke: var(--tm-muted); stroke-width: 1; stroke-dasharray: 3 3; opacity: 0.72; pointer-events: none; }
        .tm-z-hcell { cursor: pointer; transition: stroke .1s ease, opacity .1s ease; }
        .tm-z-hcell:hover { stroke: var(--tm-text); stroke-width: 1.3; }
        .tm-z-wbar { cursor: pointer; transition: opacity .12s ease, filter .12s ease; }
        .tm-z-wbar:hover { filter: brightness(1.08); stroke: var(--tm-text); stroke-width: 1; }
        .tm-z-slice { cursor: pointer; transform-box: fill-box; transform-origin: center; transition: transform .16s ease, opacity .16s ease; }
        .tm-z-donut-svg.has-active .tm-z-slice { opacity: 0.42; }
        .tm-z-donut-svg.has-active .tm-z-slice.active { opacity: 1; transform: scale(1.035); }
        .tm-z-tip { position: fixed; z-index: 2147483647; pointer-events: none; min-width: 158px; max-width: 270px; background: var(--tm-card); border: 1px solid var(--tm-border); border-radius: 10px; box-shadow: 0 12px 30px -8px rgba(15,23,42,0.22), 0 2px 6px rgba(15,23,42,0.08); padding: 9px 11px; font-size: 11px; color: var(--tm-text); opacity: 0; transform: translate3d(0, 3px, 0); transition: opacity .1s ease, transform .1s ease; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
        .tm-z-tip.show { opacity: 1; transform: translate3d(0, 0, 0); }
        .tm-z-tip-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; font-weight: 600; font-size: 11.5px; color: var(--tm-text); padding-bottom: 5px; margin-bottom: 5px; border-bottom: 1px solid var(--tm-hairline); }
        .tm-z-tip-head em { font-style: normal; font-family: var(--tm-mono); font-size: 10.5px; font-weight: 500; color: var(--tm-muted); }
        .tm-z-tip-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 2px 0; line-height: 1.35; }
        .tm-z-tip-k { display: inline-flex; align-items: center; gap: 5px; color: var(--tm-sub); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tm-z-tip-v { font-family: var(--tm-mono); font-weight: 600; color: var(--tm-text); flex-shrink: 0; font-variant-numeric: tabular-nums; }

        .tm-pref-row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; }
        .tm-toggles { display: flex; flex-wrap: wrap; gap: 6px; }
        .tm-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--tm-border); background: var(--tm-card); color: var(--tm-muted); font-size: 11.5px; cursor: pointer; transition: all .14s ease; }
        .tm-pill input { display: none; }
        .tm-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--tm-faint); transition: background .14s; }
        .tm-pill.on { border-color: var(--tm-z-blue); color: var(--tm-text); font-weight: 500; }
        .tm-pill.on .tm-pill-dot { background: var(--tm-z-blue); }
      \`;
    }

    function positionPopover() {
      if (!shadow || !hostEl) return;
      var pop = shadow.getElementById('tm-popover');
      if (!pop || !state.popoverOpen) return;
      var vv = window.visualViewport;
      var vw = vv ? vv.width : window.innerWidth;
      var vh = vv ? vv.height : window.innerHeight;
      var anchorEl = shadow.querySelector('[data-tm-chip="' + state.activeTab + '"]') || hostEl;
      var rect = anchorEl.getBoundingClientRect();
      var pw = pop.offsetWidth || 320;
      var ph = pop.offsetHeight || 220;
      var centeredLeft = rect.left + rect.width / 2 - pw / 2;
      var left = Math.max(10, Math.min(vw - pw - 10, centeredLeft));
      var top = rect.top - ph - 8;
      if (top < 10) top = Math.max(10, Math.min(vh - ph - 10, rect.bottom + 8));
      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
    }

    function renderBar() {
      if (!shadow || !hostEl) return;
      state.dark = detectDarkTheme();
      hostEl.setAttribute('data-theme', state.dark ? 'dark' : 'light');
      hostEl.setAttribute('data-style', currentStyle());

      var snap = state.snapshot;
      var conv = snap && snap.conversation;
      var usage = snap && snap.usage;
      var quotas = (snap && snap.quotas) || [];
      var prefs = state.prefs;

      var tpsVal = conv && (conv.latestTps != null ? conv.latestTps : conv.tps);
      var cacheVal = conv && conv.cacheHitRate;
      var ctxFrac = conv && conv.context && conv.context.usedFraction;
      var leadQuota = quotas[0] || null;
      var quotaPair = (snap && snap.quotaPair) || null;
      var hasQuota = Boolean(quotaPair || leadQuota);
      var isRunning = Boolean(conv && conv.running);
      var starCls = !snap || !snap.connected ? 'off' : isRunning ? 'live' : 'idle';
      var expanded = state.popoverOpen ? 'true' : 'false';

      var showSpeed = prefs.showSpeed !== false;
      var showCache = prefs.showCache !== false;
      var showContext = prefs.showContext !== false;
      var showQuota = prefs.showQuota !== false && hasQuota;
      var showToday = prefs.showToday === true && Boolean(usage);
      var showMonth = prefs.showMonth === true && Boolean(usage);
      var enabledTabs = [];
      if (showSpeed) enabledTabs.push('speed');
      if (showCache) enabledTabs.push('cache');
      if (showContext) enabledTabs.push('context');
      if (showQuota) enabledTabs.push('quota');
      if (showToday) enabledTabs.push('today');
      if (showMonth) enabledTabs.push('month');

      var layout = computeBarLayout(enabledTabs, state.freeWidth);
      state.density = layout.density;
      state.overflowTabs = layout.hidden;
      hostEl.setAttribute('data-density', layout.density);

      var visibleTabs = layout.shown.slice();
      if (layout.hidden.length > 0) visibleTabs.push('more');
      if (visibleTabs.length === 0) visibleTabs.push('brand');
      if (visibleTabs.indexOf(state.activeTab) < 0) state.activeTab = visibleTabs[0];

      var isCompact = layout.density !== 'full';
      var langKey = prefs.language === 'en' ? 'en' : 'zh-CN';
      var layoutKey = [langKey, layout.density, layout.shown.join(','), layout.hidden.length].join('|');

      var chipsEl = shadow.getElementById('tm-chips');
      if (chipsEl) {
        if (state.barLayoutKey !== layoutKey || !chipsEl.firstChild) {
          var barStar = buildSparkleIcon(starCls, false);
          var chipItems = [];
          for (var ci = 0; ci < layout.shown.length; ci++) {
            var ck = layout.shown[ci];
            var leadStar = chipItems.length === 0 ? barStar : '';
            if (ck === 'speed') {
              chipItems.push('<button class="tm-chip" type="button" aria-expanded="false" data-tm-chip="speed" data-tm-trigger="1">' + leadStar + '<span class="tm-val" data-tm-v="speed">--</span>' + (isCompact ? '' : '<span class="tm-unit">' + escapeHtml(t('speedUnit')) + '</span>') + '</button>');
            } else if (ck === 'cache') {
              chipItems.push('<button class="tm-chip" type="button" aria-expanded="false" data-tm-chip="cache" data-tm-trigger="1">' + leadStar + '<span class="tm-label">' + escapeHtml(isCompact ? t('cacheShort') : t('cacheHit')) + '</span><span class="tm-val" data-tm-v="cache">--</span></button>');
            } else if (ck === 'context') {
              chipItems.push('<button class="tm-chip" type="button" aria-expanded="false" data-tm-chip="context" data-tm-trigger="1">' + leadStar + buildContextRingSvg(ctxFrac, 'bar') + (isCompact ? '' : '<span class="tm-label">' + escapeHtml(t('context')) + '</span>') + '<span class="tm-val" data-tm-v="ctx">--</span></button>');
            } else if (ck === 'quota') {
              chipItems.push('<button class="tm-chip" type="button" aria-expanded="false" data-tm-chip="quota" data-tm-trigger="1" title="' + escapeHtml(t('quotaPairTip')) + '">' + leadStar + (isCompact ? '' : '<span class="tm-label">' + escapeHtml(t('quota')) + '</span>') + '<span class="tm-val" data-tm-v="quota"><span data-tm-q="l">--</span><span class="tm-slash">/</span><span data-tm-q="r">--</span></span></button>');
            } else if (ck === 'today') {
              chipItems.push('<button class="tm-chip" type="button" aria-expanded="false" data-tm-chip="today" data-tm-trigger="1">' + leadStar + '<span class="tm-label">' + escapeHtml(isCompact ? t('todayShort') : t('today')) + '</span><span class="tm-val" data-tm-v="today">--</span></button>');
            } else if (ck === 'month') {
              chipItems.push('<button class="tm-chip" type="button" aria-expanded="false" data-tm-chip="month" data-tm-trigger="1">' + leadStar + '<span class="tm-label">' + escapeHtml(isCompact ? t('monthShort') : t('month')) + '</span><span class="tm-val" data-tm-v="month">--</span></button>');
            }
          }
          if (layout.density === 'mini') {
            chipItems.push('<button class="tm-chip tm-chip-more" type="button" aria-expanded="false" data-tm-chip="more" data-tm-trigger="1" title="' + escapeHtml(t('moreMetrics')) + '">' + barStar + '<span>+' + layout.hidden.length + '</span></button>');
          } else if (layout.hidden.length > 0) {
            chipItems.push('<button class="tm-chip tm-chip-more" type="button" aria-expanded="false" data-tm-chip="more" data-tm-trigger="1" title="' + escapeHtml(t('moreMetrics')) + '">+' + layout.hidden.length + '</button>');
          }
          chipsEl.innerHTML = chipItems.length
            ? chipItems.join('<span class="tm-sep" aria-hidden="true"></span>')
            : '<button class="tm-chip" type="button" aria-expanded="false" data-tm-chip="brand" data-tm-trigger="1">' + barStar + '<span class="tm-val">' + escapeHtml(t('brand')) + '</span></button>';
          state.barLayoutKey = layoutKey;
        }

        chipsEl.querySelectorAll('[data-tm-chip]').forEach(function(btn) {
          var isCur = state.popoverOpen && btn.getAttribute('data-tm-chip') === state.activeTab;
          btn.setAttribute('aria-expanded', isCur ? 'true' : 'false');
          btn.classList.toggle('active', isCur);
        });
        var starSvg = chipsEl.querySelector('.tm-star');
        if (starSvg) starSvg.setAttribute('class', 'tm-star ' + starCls);

        var speedEl = chipsEl.querySelector('[data-tm-v="speed"]');
        if (speedEl) speedEl.textContent = fmtFixed(tpsVal, 1) || '--';
        var cacheEl = chipsEl.querySelector('[data-tm-v="cache"]');
        if (cacheEl) cacheEl.textContent = fmtPct(cacheVal);
        var ctxEl = chipsEl.querySelector('[data-tm-v="ctx"]');
        if (ctxEl) ctxEl.textContent = fmtPct(ctxFrac);
        var qParts = getQuotaPairParts(quotaPair, leadQuota);
        var qWrap = chipsEl.querySelector('[data-tm-v="quota"]');
        if (qWrap) {
          var ql = qWrap.querySelector('[data-tm-q="l"]');
          var qr = qWrap.querySelector('[data-tm-q="r"]');
          var qSlash = qWrap.querySelector('.tm-slash');
          if (qParts.single !== undefined) {
            if (ql) ql.textContent = qParts.single;
            if (qSlash) qSlash.style.display = 'none';
            if (qr) qr.textContent = '';
          } else {
            if (ql) ql.textContent = qParts.left;
            if (qSlash) qSlash.style.display = '';
            if (qr) qr.textContent = qParts.right;
          }
        }
        var todayEl = chipsEl.querySelector('[data-tm-v="today"]');
        if (todayEl) todayEl.textContent = usage ? fmtTokens(usage.todayTokens) : '--';
        var monthEl = chipsEl.querySelector('[data-tm-v="month"]');
        if (monthEl) monthEl.textContent = usage ? fmtTokens(usage.monthTokens) : '--';
        syncContextRingEl(chipsEl.querySelector('[data-tm-ring="bar"]'), ctxFrac);
      }

      var pop = shadow.getElementById('tm-popover');
      if (pop) {
        pop.classList.toggle('open', state.popoverOpen);
        if (state.popoverOpen) {
          if ((state.pointerInPop || state.hoveringPopChart) && state.lastRenderedTab === state.activeTab) {
            positionPopover();
            return;
          }
          state.lastRenderedTab = state.activeTab;
          var card = buildFocusedPopoverModel(state.activeTab, snap, conv, usage, quotas);
          var styleNext = THEMES[(THEMES.indexOf(currentStyle()) + 1) % THEMES.length];
          var styleBtnText = currentStyle() === 'swiss' ? t('themeSwiss') : currentStyle() === 'glass' ? t('themeGlass') : t('themeMono');
          var isCopied = Date.now() < state.copiedUntil;

          var nextPopHtml =
            '<div class="tm-head">' +
              '<div class="tm-brand-row">' + buildSparkleIcon(starCls, true) +
                '<span class="tm-model" title="' + escapeHtml(card.title) + '">' + escapeHtml(card.title) + '</span>' +
                (card.badge ? '<span class="tm-status-tag">' + escapeHtml(card.badge) + '</span>' : '') +
              '</div>' +
              '<div class="tm-head-acts">' +
                '<button class="tm-btn" type="button" id="tm-style-btn" title="' + escapeHtml(t('themeLabel')) + '">' + escapeHtml(styleBtnText) + '</button>' +
                '<button class="tm-btn" type="button" id="tm-copy-btn">' + escapeHtml(isCopied ? t('copied') : t('copyShort')) + '</button>' +
                '<button class="tm-btn" type="button" id="tm-lang-btn">' + (prefs.language === 'en' ? '中' : 'EN') + '</button>' +
              '</div>' +
            '</div>' +
            card.body +
            '<div class="tm-foot">' +
              '<span class="tm-foot-ctx" title="' + escapeHtml(card.footCtx || '') + '">' + escapeHtml(card.footCtx || '') + '</span>' +
              '<button class="tm-link" type="button" id="tm-open-modal">' + escapeHtml(t('openStats')) + '</button>' +
            '</div>';

          if (state.lastPopHtml !== nextPopHtml || !pop.firstChild) {
            state.lastPopHtml = nextPopHtml;
            pop.innerHTML = nextPopHtml;
            bindPopoverCharts(pop, card.chartMeta);
          }
          positionPopover();
        }
      }
    }

    /**
     * 为浮卡内的「近 14 天趋势」柱状图与「生成速率」折线图绑定 0ms 零延迟悬停高亮与自定义跟随气泡。
     */
    function bindPopoverCharts(popRoot, meta) {
      if (!popRoot || !meta) return;

      function placeMiniTip(tipEl, wrapEl, fracX, topPx, html) {
        if (!tipEl || !wrapEl) return;
        tipEl.innerHTML = html;
        tipEl.classList.add('show');
        var wrapW = wrapEl.offsetWidth || 278;
        var tipW = tipEl.offsetWidth || 110;
        var rawLeft = fracX * wrapW;
        var half = tipW / 2;
        var clamped = Math.max(half + 2, Math.min(wrapW - half - 2, rawLeft));
        tipEl.style.left = Math.round(clamped) + 'px';
        tipEl.style.top = Math.max(0, Math.round(topPx)) + 'px';
      }

      if (meta.kind === 'trend14') {
        var svg = popRoot.querySelector('#tm-trend-svg');
        var tip = popRoot.querySelector('#tm-trend-tip');
        var readout = popRoot.querySelector('#tm-trend-readout');
        var wrap = svg && svg.parentElement;
        if (!svg || !meta.items || !meta.items.length) return;
        var bars = svg.querySelectorAll('.tm-trend-bar');

        function activateBar(idx) {
          var item = meta.items[idx];
          if (!item) return;
          state.hoveringPopChart = true;
          svg.classList.add('has-hover');
          bars.forEach(function(b) {
            b.classList.toggle('active', Number(b.getAttribute('data-t-idx')) === idx);
          });
          if (readout) {
            readout.textContent = fmtShortDate(item.key) + ' · ' + fmtTokens(item.val);
          }
          var reqLine = item.reqs > 0 ? '<div class="tm-mini-tip-sub">' + item.reqs.toLocaleString() + ' ' + escapeHtml(t('requests')) + '</div>' : '';
          var topY = Math.max(4, Math.min(item.topY, meta.h - 14));
          placeMiniTip(
            tip,
            wrap,
            item.cx / meta.w,
            topY,
            '<div><span class="tm-mini-tip-date">' + escapeHtml(item.key) + '</span><span class="tm-mini-tip-val">' + escapeHtml(fmtTokens(item.val)) + '</span></div>' + reqLine
          );
        }

        function clearBar() {
          state.hoveringPopChart = false;
          svg.classList.remove('has-hover');
          bars.forEach(function(b) { b.classList.remove('active'); });
          if (readout) readout.textContent = '';
          if (tip) tip.classList.remove('show');
        }

        svg.addEventListener('mousemove', function(ev) {
          var attr = ev.target && ev.target.getAttribute ? ev.target.getAttribute('data-t-idx') : null;
          if (attr !== null && attr !== '') {
            activateBar(Number(attr));
            return;
          }
          var rect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
          if (rect && rect.width > 0) {
            var frac = Math.max(0, Math.min(0.9999, (ev.clientX - rect.left) / rect.width));
            activateBar(Math.floor(frac * meta.items.length));
          }
        });
        svg.addEventListener('mouseover', function(ev) {
          var attr = ev.target && ev.target.getAttribute ? ev.target.getAttribute('data-t-idx') : null;
          if (attr !== null && attr !== '') activateBar(Number(attr));
        });
        svg.addEventListener('mouseleave', clearBar);
      } else if (meta.kind === 'spark') {
        var spSvg = popRoot.querySelector('#tm-spark-svg');
        var spTip = popRoot.querySelector('#tm-spark-tip');
        var spWrap = spSvg && spSvg.parentElement;
        if (!spSvg || !meta.items || !meta.items.length) return;
        var spXhair = spSvg.querySelector('#tm-sp-xhair');
        var spHalo = spSvg.querySelector('#tm-sp-halo');
        var spDot = spSvg.querySelector('#tm-sp-dot');

        spSvg.addEventListener('mousemove', function(ev) {
          var rect = spSvg.getBoundingClientRect ? spSvg.getBoundingClientRect() : null;
          if (!rect || rect.width <= 0) return;
          state.hoveringPopChart = true;
          spSvg.classList.add('has-hover');
          var svgX = ((ev.clientX - rect.left) / rect.width) * meta.w;
          var ratio = Math.max(0, Math.min(1, (svgX - meta.padX) / Math.max(1, meta.w - meta.padX * 2)));
          var idx = Math.round(ratio * (meta.items.length - 1));
          var it = meta.items[idx];
          if (!it) return;
          if (spXhair) { spXhair.setAttribute('x1', it.x.toFixed(1)); spXhair.setAttribute('x2', it.x.toFixed(1)); spXhair.style.display = ''; }
          if (spHalo) { spHalo.setAttribute('cx', it.x.toFixed(1)); spHalo.setAttribute('cy', it.y.toFixed(1)); spHalo.style.display = ''; }
          if (spDot) { spDot.setAttribute('cx', it.x.toFixed(1)); spDot.setAttribute('cy', it.y.toFixed(1)); spDot.style.display = ''; }
          var tpsStr = fmtFixed(it.tps, 1) || '--';
          var ttftStr = fmtFixed(it.ttft, 2);
          var subParts = [];
          if (ttftStr !== null) subParts.push(t('ttft') + ' ' + ttftStr + 's');
          if (it.tokens > 0) subParts.push(fmtTokens(it.tokens) + ' tok');
          placeMiniTip(
            spTip,
            spWrap,
            it.x / meta.w,
            Math.max(4, it.y - 2),
            '<div><span class="tm-mini-tip-date">#' + it.idx + '</span><span class="tm-mini-tip-val">' + escapeHtml(tpsStr + ' ' + t('speedUnit')) + '</span></div>' +
            (subParts.length ? '<div class="tm-mini-tip-sub">' + escapeHtml(subParts.join(' · ')) + '</div>' : '')
          );
        });
        spSvg.addEventListener('mouseleave', function() {
          state.hoveringPopChart = false;
          spSvg.classList.remove('has-hover');
          if (spXhair) spXhair.style.display = 'none';
          if (spHalo) spHalo.style.display = 'none';
          if (spDot) spDot.style.display = 'none';
          if (spTip) spTip.classList.remove('show');
        });
      }
    }

    function renderModal(force) {
      if (!state.modalOpen) {
        state.lastModalHtml = '';
        if (modalHost) { modalHost.remove(); modalHost = null; modalShadow = null; }
        return;
      }
      // 鼠标正在图表上查看悬停浮窗时跳过后台静默重绘，避免准星与浮窗闪断
      if (!force && modalShadow) {
        var curTip = modalShadow.getElementById('tm-z-tip');
        if (curTip && curTip.classList.contains('show')) return;
      }
      if (!modalHost) {
        modalHost = document.createElement('div');
        modalHost.id = MODAL_ID;
        modalShadow = modalHost.attachShadow({ mode: 'closed' });
        document.body.appendChild(modalHost);
      }
      modalHost.setAttribute('data-theme', state.dark ? 'dark' : 'light');
      modalHost.setAttribute('data-style', currentStyle());

      var usage = (state.snapshot && state.snapshot.usage) || { days: [], modelRank: [] };
      var peakVal = usage.peakDay ? safeInt(usage.peakDay.total) : 0;
      var peakDate = usage.peakDay && usage.peakDay.date ? usage.peakDay.date : '';
      var curStreak = safeInt(usage.currentStreak);
      var maxStreak = safeInt(usage.longestStreak);

      var actMode = state.modalActivityMode || 'daily';
      var rangeDays = state.modalRangeDays === 30 ? 30 : 7;
      var trendModel = state.modalTrendModel || 'ALL';

      var rangeInfo = computeRangeModelBreakdown(usage, rangeDays);
      var topModels = rangeInfo.ranked.slice(0, 5).map(function(m) { return m.model; });
      if (trendModel !== 'ALL' && trendModel !== '__OTHER__' && topModels.indexOf(trendModel) < 0) trendModel = 'ALL';
      if (trendModel === '__OTHER__' && !rangeInfo.hasOtherInRange) trendModel = 'ALL';

      var legendHtml =
        '<button type="button" class="tm-z-leg ' + (trendModel === 'ALL' ? 'active' : '') + '" data-trend-model="ALL"><i class="tm-z-dot"></i>' + escapeHtml(t('allModels')) + '</button>' +
        topModels.map(function(name, idx) {
          return '<button type="button" class="tm-z-leg ' + (trendModel === name ? 'active' : '') + '" data-trend-model="' + escapeHtml(name) + '"><i class="tm-z-dot" style="background:' + Z_PALETTE[idx % Z_PALETTE.length] + '"></i>' + escapeHtml(name) + '</button>';
        }).join('') +
        (rangeInfo.hasOtherInRange
          ? '<button type="button" class="tm-z-leg ' + (trendModel === '__OTHER__' ? 'active' : '') + '" data-trend-model="__OTHER__"><i class="tm-z-dot" style="background:#94a3b8"></i>' + escapeHtml(t('otherModels')) + '</button>'
          : '');

      var actChart = buildZActivitySvg(usage, actMode);
      var trendChart = buildZSmoothTrendSvg(usage, rangeDays, trendModel);
      var donutChart = buildZModelDonutHtml(usage, rangeDays);
      var modelsHtml = donutChart.html;

      var actSeg = [
        ['daily', t('actDaily')],
        ['weekly', t('actWeekly')],
        ['cumulative', t('actCumulative')],
      ].map(function(pair) {
        return '<button class="tm-z-seg-btn' + (actMode === pair[0] ? ' active' : '') + '" type="button" data-act-mode="' + pair[0] + '">' + escapeHtml(pair[1]) + '</button>';
      }).join('');

      var rangeSeg = [
        [7, t('range7d')],
        [30, t('range30d')],
      ].map(function(pair) {
        return '<button class="tm-z-seg-btn' + (rangeDays === pair[0] ? ' active' : '') + '" type="button" data-range-days="' + pair[0] + '">' + escapeHtml(pair[1]) + '</button>';
      }).join('');

      var toggles = [
        ['showSpeed', t('optSpeed')],
        ['showCache', t('optCache')],
        ['showContext', t('optContext')],
        ['showQuota', t('optQuota')],
        ['showToday', t('optToday')],
        ['showMonth', t('optMonth')],
      ].map(function(pair) {
        var on = Boolean(state.prefs[pair[0]]);
        return '<label class="tm-pill ' + (on ? 'on' : '') + '"><input type="checkbox" data-pref-key="' + escapeHtml(pair[0]) + '"' + (on ? ' checked' : '') + '/><span class="tm-pill-dot"></span>' + escapeHtml(pair[1]) + '</label>';
      }).join('');

      var styleSeg = [
        ['swiss', t('themeSwiss')],
        ['glass', t('themeGlass')],
        ['mono', t('themeMono')],
      ].map(function(pair) {
        var active = currentStyle() === pair[0] ? ' active' : '';
        return '<button class="tm-z-seg-btn' + active + '" type="button" data-theme-pick="' + pair[0] + '">' + escapeHtml(pair[1]) + '</button>';
      }).join('');

      var nextModalHtml =
        '<style>' + modalStyles() + '</style>' +
        '<div class="tm-backdrop" id="tm-backdrop" role="dialog" aria-modal="true">' +
          '<div class="tm-modal" id="tm-modal-scroll">' +
            '<div class="tm-mhead">' +
              '<div class="tm-mtitle-wrap"><span class="tm-mtitle">' + escapeHtml(t('statsTitle')) + '</span><span class="tm-mbadge">' + escapeHtml(t('statsBadge')) + '</span></div>' +
              '<div class="tm-head-acts">' +
                '<button class="tm-btn" type="button" id="tm-modal-copy">' + escapeHtml(Date.now() < state.copiedUntil ? t('copied') : t('copyStats')) + '</button>' +
                '<button class="tm-btn" type="button" id="tm-modal-lang">' + (state.prefs.language === 'en' ? '中' : 'EN') + '</button>' +
                '<button class="tm-btn" type="button" id="tm-close-modal">' + escapeHtml(t('close')) + '</button>' +
              '</div>' +
            '</div>' +
            '<div class="tm-z-kpis">' +
              '<div class="tm-z-kpi"><div class="tm-z-kpi-v">' + escapeHtml(fmtStatsTokens(usage.totalTokens)) + '</div><div class="tm-z-kpi-k">' + escapeHtml(t('kpiTotalTokens')) + (usage.totalCostUsd != null ? '<div style="font-size:10px;color:var(--tm-cost,#059669);font-family:var(--tm-mono);font-weight:600;margin-top:2px;">' + escapeHtml(fmtUsd(usage.totalCostUsd)) + '</div>' : '') + '</div></div>' +
              '<div class="tm-z-kpi"><div class="tm-z-kpi-v">' + escapeHtml(fmtStatsTokens(usage.monthTokens)) + '</div><div class="tm-z-kpi-k">' + escapeHtml(t('kpiMonthTokens')) + (usage.monthCostUsd != null ? '<div style="font-size:10px;color:var(--tm-cost,#059669);font-family:var(--tm-mono);font-weight:600;margin-top:2px;">' + escapeHtml(fmtUsd(usage.monthCostUsd)) + '</div>' : '') + '</div></div>' +
              '<div class="tm-z-kpi" title="' + escapeHtml(peakDate) + '"><div class="tm-z-kpi-v">' + escapeHtml(fmtStatsTokens(peakVal)) + '</div><div class="tm-z-kpi-k">' + escapeHtml(t('kpiPeakTokens')) + '</div></div>' +
              '<div class="tm-z-kpi"><div class="tm-z-kpi-v">' + (state.prefs.language === 'en' ? (curStreak + t('daysUnit')) : (curStreak + ' ' + t('daysUnit'))) + '</div><div class="tm-z-kpi-k">' + escapeHtml(t('kpiCurrentStreak')) + '</div></div>' +
              '<div class="tm-z-kpi"><div class="tm-z-kpi-v">' + (state.prefs.language === 'en' ? (maxStreak + t('daysUnit')) : (maxStreak + ' ' + t('daysUnit'))) + '</div><div class="tm-z-kpi-k">' + escapeHtml(t('kpiLongestStreak')) + '</div></div>' +
            '</div>' +
            '<div class="tm-z-card">' +
              '<div class="tm-z-card-head"><span class="tm-z-card-title">' + escapeHtml(t('tokenActivity')) + '</span><div class="tm-z-seg">' + actSeg + '</div></div>' +
              actChart.html +
            '</div>' +
            '<div class="tm-z-toolbar"><span class="tm-z-toolbar-label">' + escapeHtml(t('timeRange')) + '</span><div class="tm-z-seg">' + rangeSeg + '</div></div>' +
            '<div class="tm-z-card">' +
              '<div class="tm-z-card-head"><span class="tm-z-card-title">' + escapeHtml(t('dailyTokenTrend')) + '</span><span class="tm-z-card-sub">' + escapeHtml(t('today')) + ' ' + escapeHtml(fmtStatsTokens(usage.todayTokens)) + '</span></div>' +
              '<div class="tm-z-legends">' + legendHtml + '</div>' +
              trendChart.html +
            '</div>' +
            '<div class="tm-z-card">' +
              '<div class="tm-z-card-head"><span class="tm-z-card-title">' + escapeHtml(t('modelUsageTitle')) + '</span><span class="tm-z-card-sub">' + safeInt(rangeInfo.rangeRequests).toLocaleString() + ' ' + escapeHtml(t('requests')) + '</span></div>' +
              modelsHtml +
            '</div>' +
            '<div class="tm-z-card">' +
              '<div class="tm-z-card-head"><span class="tm-z-card-title">' + escapeHtml(t('customizeTitle')) + '</span><span class="tm-z-card-sub">' + escapeHtml(t('themeLabel')) + '</span></div>' +
              '<div class="tm-pref-row"><div class="tm-toggles">' + toggles + '</div><div class="tm-z-seg">' + styleSeg + '</div></div>' +
            '</div>' +
          '</div>' +
          '<div class="tm-z-tip" id="tm-z-tip" aria-hidden="true"></div>' +
        '</div>';

      if (state.lastModalHtml === nextModalHtml && modalShadow.firstChild) return;
      var prevScrollEl = modalShadow.getElementById('tm-modal-scroll');
      var savedScrollTop = prevScrollEl ? prevScrollEl.scrollTop : 0;
      state.lastModalHtml = nextModalHtml;
      modalShadow.innerHTML = nextModalHtml;
      var nextScrollEl = modalShadow.getElementById('tm-modal-scroll');
      if (nextScrollEl && savedScrollTop > 0) nextScrollEl.scrollTop = savedScrollTop;

      modalShadow.getElementById('tm-close-modal').onclick = function() { state.modalOpen = false; renderModal(); };
      modalShadow.getElementById('tm-modal-lang').onclick = function(ev) {
        if (!ev || ev.isTrusted !== true) return;
        void updatePrefs({ language: state.prefs.language === 'en' ? 'zh-CN' : 'en' });
      };
      modalShadow.getElementById('tm-modal-copy').onclick = function(ev) {
        if (!ev || ev.isTrusted !== true) return;
        if (copyTextSafe(buildCopySummaryText())) {
          state.copiedUntil = Date.now() + 1600;
          renderModal(true);
          setTimeout(function() { if (!state.disposed && state.modalOpen) renderModal(true); }, 1650);
        }
      };
      modalShadow.getElementById('tm-backdrop').onclick = function(e) {
        if (e.target && e.target.id === 'tm-backdrop') { state.modalOpen = false; renderModal(); }
      };
      modalShadow.querySelectorAll('[data-act-mode]').forEach(function(btn) {
        btn.onclick = function(ev) {
          if (!ev || ev.isTrusted !== true) return;
          state.modalActivityMode = btn.getAttribute('data-act-mode') || 'daily';
          renderModal(true);
        };
      });
      modalShadow.querySelectorAll('[data-range-days]').forEach(function(btn) {
        btn.onclick = function(ev) {
          if (!ev || ev.isTrusted !== true) return;
          state.modalRangeDays = Number(btn.getAttribute('data-range-days')) === 30 ? 30 : 7;
          renderModal(true);
        };
      });
      modalShadow.querySelectorAll('[data-trend-model]').forEach(function(btn) {
        btn.onclick = function(ev) {
          if (!ev || ev.isTrusted !== true) return;
          state.modalTrendModel = btn.getAttribute('data-trend-model') || 'ALL';
          renderModal(true);
        };
      });
      modalShadow.querySelectorAll('input[data-pref-key]').forEach(function(inp) {
        inp.onchange = function(ev) {
          if (!ev || ev.isTrusted !== true) return;
          var patch = {};
          patch[inp.getAttribute('data-pref-key')] = Boolean(inp.checked);
          void updatePrefs(patch);
        };
      });
      modalShadow.querySelectorAll('[data-theme-pick]').forEach(function(btn) {
        btn.onclick = function(ev) {
          if (!ev || ev.isTrusted !== true) return;
          void updatePrefs({ theme: btn.getAttribute('data-theme-pick') });
        };
      });

      // 绑定全部图表的 0ms 零延迟跟随交互：准星、高亮节点、自定义浮窗与圆环双向联动
      var tipEl = modalShadow.getElementById('tm-z-tip');
      function placeTip(ev, html) {
        if (!tipEl) return;
        tipEl.innerHTML = html;
        tipEl.classList.add('show');
        var vv = window.visualViewport;
        var vw = vv ? vv.width : window.innerWidth;
        var vh = vv ? vv.height : window.innerHeight;
        var tw = tipEl.offsetWidth || 190;
        var th = tipEl.offsetHeight || 72;
        var x = (ev.clientX || 0) + 14;
        var y = (ev.clientY || 0) - th - 12;
        if (x + tw + 10 > vw) x = Math.max(10, (ev.clientX || 0) - tw - 14);
        if (y < 10) y = Math.min(vh - th - 10, (ev.clientY || 0) + 16);
        tipEl.style.left = Math.round(x) + 'px';
        tipEl.style.top = Math.round(y) + 'px';
      }
      function hideTip() {
        if (tipEl) tipEl.classList.remove('show');
      }

      // 1. Token 活动：每日热力图 / 每周柱图实时浮卡
      var actSvg = modalShadow.getElementById('tm-zact-svg');
      if (actSvg) {
        actSvg.addEventListener('mousemove', function(ev) {
          var target = ev.target;
          var ttl = target && target.getAttribute ? target.getAttribute('data-z-title') : null;
          if (!ttl) { hideTip(); return; }
          var val = target.getAttribute('data-z-val') || '0';
          placeTip(ev,
            '<div class="tm-z-tip-head"><span>' + escapeHtml(ttl) + '</span></div>' +
            '<div class="tm-z-tip-row"><span class="tm-z-tip-k"><i class="tm-z-dot"></i>' + escapeHtml(t('tokenActivity')) + '</span><span class="tm-z-tip-v">' + escapeHtml(val) + '</span></div>'
          );
        });
        actSvg.addEventListener('mouseleave', hideTip);
      }

      // 2. Token 活动：累计平滑面积图（准星 + 高亮节点 + 当日新增/截至累计浮卡）
      var cumSvg = modalShadow.getElementById('tm-zcum-svg');
      if (cumSvg && actChart.meta && actChart.meta.kind === 'cumulative') {
        var cm = actChart.meta;
        var cXhair = modalShadow.getElementById('tm-zcum-xhair');
        var cHalo = modalShadow.getElementById('tm-zcum-halo');
        var cDot = modalShadow.getElementById('tm-zcum-dot');
        cumSvg.addEventListener('mousemove', function(ev) {
          var rect = cumSvg.getBoundingClientRect();
          if (!rect || rect.width <= 0 || !cm.series.length) return;
          var svgX = ((ev.clientX - rect.left) / rect.width) * cm.cw;
          var ratio = Math.max(0, Math.min(1, (svgX - cm.padL) / Math.max(1, cm.cw - cm.padL - cm.padR)));
          var idx = Math.round(ratio * (cm.series.length - 1));
          var item = cm.series[idx];
          var pt = cm.pts[idx];
          if (!item || !pt) return;
          if (cXhair) { cXhair.setAttribute('x1', pt[0].toFixed(1)); cXhair.setAttribute('x2', pt[0].toFixed(1)); cXhair.style.display = ''; }
          if (cHalo) { cHalo.setAttribute('cx', pt[0].toFixed(1)); cHalo.setAttribute('cy', pt[1].toFixed(1)); cHalo.style.display = ''; }
          if (cDot) { cDot.setAttribute('cx', pt[0].toFixed(1)); cDot.setAttribute('cy', pt[1].toFixed(1)); cDot.style.display = ''; }
          placeTip(ev,
            '<div class="tm-z-tip-head"><span>' + escapeHtml(item.key) + '</span></div>' +
            '<div class="tm-z-tip-row"><span class="tm-z-tip-k"><i class="tm-z-dot"></i>' + escapeHtml(t('cumLabel')) + '</span><span class="tm-z-tip-v">' + escapeHtml(fmtStatsTokens(item.val)) + '</span></div>' +
            '<div class="tm-z-tip-row"><span class="tm-z-tip-k"><i class="tm-z-dot" style="background:var(--tm-muted)"></i>' + escapeHtml(t('dayDelta')) + '</span><span class="tm-z-tip-v">' + escapeHtml(fmtStatsTokens(item.delta)) + '</span></div>'
          );
        });
        cumSvg.addEventListener('mouseleave', function() {
          if (cXhair) cXhair.style.display = 'none';
          if (cHalo) cHalo.style.display = 'none';
          if (cDot) cDot.style.display = 'none';
          hideTip();
        });
      }

      // 3. 每日 Token 趋势图（全列吸附准星 + 多曲线交点发光高亮 + 仅展示当日 >0 用量模型明细）
      var trendSvg = modalShadow.getElementById('tm-ztrend-svg');
      if (trendSvg && trendChart.meta) {
        var tm = trendChart.meta;
        var tXhair = modalShadow.getElementById('tm-ztrend-xhair');
        var tActive = modalShadow.getElementById('tm-ztrend-active');
        trendSvg.addEventListener('mousemove', function(ev) {
          var rect = trendSvg.getBoundingClientRect();
          if (!rect || rect.width <= 0 || !tm.dateKeys.length) return;
          var svgX = ((ev.clientX - rect.left) / rect.width) * tm.w;
          var ratio = Math.max(0, Math.min(1, (svgX - tm.padL) / Math.max(1, tm.plotW)));
          var idx = Math.round(ratio * (tm.dateKeys.length - 1));
          var colX = tm.padL + (idx / Math.max(1, tm.dateKeys.length - 1)) * tm.plotW;
          if (tXhair) { tXhair.setAttribute('x1', colX.toFixed(1)); tXhair.setAttribute('x2', colX.toFixed(1)); tXhair.style.display = ''; }

          var activeList = [];
          var daySum = 0;
          var dotsMarkup = '';
          for (var s = 0; s < tm.seriesList.length; s++) {
            var ser = tm.seriesList[s];
            var v = ser.values[idx] || 0;
            if (v > 0 && tm.seriesCoords[s] && tm.seriesCoords[s][idx]) {
              daySum += v;
              var pt = tm.seriesCoords[s][idx];
              activeList.push({ label: ser.label, color: ser.color, val: v });
              dotsMarkup +=
                '<circle cx="' + pt[0].toFixed(1) + '" cy="' + pt[1].toFixed(1) + '" r="8" fill="' + ser.color + '" fill-opacity="0.18"/>' +
                '<circle cx="' + pt[0].toFixed(1) + '" cy="' + pt[1].toFixed(1) + '" r="4.2" fill="var(--tm-card)" stroke="' + ser.color + '" stroke-width="2.3"/>';
            }
          }
          if (tActive) tActive.innerHTML = dotsMarkup;
          activeList.sort(function(a, b) { return b.val - a.val; });

          var rowsHtml = activeList.length
            ? activeList.map(function(row) {
                return '<div class="tm-z-tip-row"><span class="tm-z-tip-k"><i class="tm-z-dot" style="background:' + row.color + '"></i>' + escapeHtml(row.label) + '</span><span class="tm-z-tip-v">' + escapeHtml(fmtStatsTokens(row.val)) + '</span></div>';
              }).join('')
            : '<div class="tm-z-tip-row"><span class="tm-z-tip-k">' + escapeHtml(t('noData')) + '</span><span class="tm-z-tip-v">0</span></div>';

          placeTip(ev,
            '<div class="tm-z-tip-head"><span>' + escapeHtml(fmtShortDate(tm.dateKeys[idx])) + '</span><em>' + (daySum > 0 ? escapeHtml(t('sumLabel') + ' ' + fmtStatsTokens(daySum)) : '') + '</em></div>' +
            rowsHtml
          );
        });
        trendSvg.addEventListener('mouseleave', function() {
          if (tXhair) tXhair.style.display = 'none';
          if (tActive) tActive.innerHTML = '';
          hideTip();
        });
      }

      // 4. 模型用量 Donut 圆环图与右侧列表双向联动高亮 + 中心实时数值切换
      var donutSvgEl = modalShadow.getElementById('tm-zdonut-svg');
      var pieListEl = modalShadow.getElementById('tm-zpie-list');
      if (donutSvgEl && donutChart.meta) {
        var dm = donutChart.meta;
        var dValEl = modalShadow.getElementById('tm-zdonut-val');
        var dUnitEl = modalShadow.getElementById('tm-zdonut-unit');
        function setActiveSlice(idx, ev, withTip) {
          var slices = donutSvgEl.querySelectorAll('[data-z-slice]');
          var rows = pieListEl ? pieListEl.querySelectorAll('[data-z-slice]') : [];
          if (idx < 0 || !dm.slices[idx]) {
            donutSvgEl.classList.remove('has-active');
            slices.forEach(function(el) { el.classList.remove('active'); });
            rows.forEach(function(el) { el.classList.remove('active'); });
            if (dValEl) dValEl.textContent = dm.totalText;
            if (dUnitEl) dUnitEl.textContent = dm.totalUnit;
            hideTip();
            return;
          }
          donutSvgEl.classList.add('has-active');
          slices.forEach(function(el) { el.classList.toggle('active', Number(el.getAttribute('data-z-slice')) === idx); });
          rows.forEach(function(el) { el.classList.toggle('active', Number(el.getAttribute('data-z-slice')) === idx); });
          var cur = dm.slices[idx];
          if (dValEl) dValEl.textContent = cur.valText;
          if (dUnitEl) dUnitEl.textContent = cur.pctText;
          if (withTip && ev) {
            var curAvgFixed = fmtFixed(cur.avgTps, 1);
            placeTip(ev,
              '<div class="tm-z-tip-head"><span>' + escapeHtml(cur.label) + '</span><em>' + escapeHtml(cur.pctText) + '</em></div>' +
              '<div class="tm-z-tip-row"><span class="tm-z-tip-k"><i class="tm-z-dot" style="background:' + cur.color + '"></i>' + escapeHtml(t('colTotal')) + '</span><span class="tm-z-tip-v">' + escapeHtml(cur.valText + ' ' + t('tokensUnit')) + '</span></div>' +
              (curAvgFixed !== null ? '<div class="tm-z-tip-row"><span class="tm-z-tip-k">' + escapeHtml(t('colAvgTps')) + '</span><span class="tm-z-tip-v">' + curAvgFixed + ' tok/s</span></div>' : '')
            );
          }
        }
        donutSvgEl.addEventListener('mousemove', function(ev) {
          var attr = ev.target && ev.target.getAttribute ? ev.target.getAttribute('data-z-slice') : null;
          if (attr === null) { setActiveSlice(-1); return; }
          setActiveSlice(Number(attr), ev, true);
        });
        donutSvgEl.addEventListener('mouseleave', function() { setActiveSlice(-1); });
        if (pieListEl) {
          pieListEl.addEventListener('mousemove', function(ev) {
            var row = ev.target && ev.target.closest ? ev.target.closest('[data-z-slice]') : null;
            if (!row) { setActiveSlice(-1); return; }
            setActiveSlice(Number(row.getAttribute('data-z-slice')), ev, false);
          });
          pieListEl.addEventListener('mouseleave', function() { setActiveSlice(-1); });
        }
      }
    }

    async function updatePrefs(patch) {
      state.pointerInPop = false;
      state.hoveringPopChart = false;
      if (patch && typeof patch === 'object') {
        state.prefs = Object.assign({}, state.prefs, patch);
        ensureMounted();
        renderBar();
        if (state.modalOpen) renderModal(true);
      }
      state.prefPendingCount++;
      try {
        if (window.__agTokenMeterApi) {
          var next = await window.__agTokenMeterApi.setPrefs(patch);
          if (next && !next.error) {
            state.prefs = Object.assign({}, state.prefs, next);
            state.confirmedPrefVersion = Math.max(state.confirmedPrefVersion, safeInt(next.version));
            ensureMounted();
            renderBar();
            if (state.modalOpen) renderModal(true);
          }
        }
      } catch {} finally {
        state.prefPendingCount = Math.max(0, state.prefPendingCount - 1);
      }
    }

    function ensureMounted() {
      if (state.disposed) return;
      var anchor = findMountAnchor();
      if (!anchor || !anchor.parent) {
        if (hostEl && hostEl.isConnected) hostEl.remove();
        return;
      }

      if (!hostEl) {
        hostEl = document.createElement('div');
        hostEl.id = HOST_ID;
        shadow = hostEl.attachShadow({ mode: 'closed' });
        shadow.innerHTML =
          '<style>' + baseStyles() + '</style>' +
          '<div class="tm-bar-wrap" id="tm-wrap"><div class="tm-chips" id="tm-chips"></div><div class="tm-popover" id="tm-popover"></div></div>';

        var wrap = shadow.getElementById('tm-wrap');
        var chipsNode = shadow.getElementById('tm-chips');
        var popNode = shadow.getElementById('tm-popover');
        chipsNode.addEventListener('mouseover', function(e) {
          var chip = e.target && e.target.closest ? e.target.closest('[data-tm-chip]') : null;
          if (!chip) return;
          clearTimeout(state.hoverTimer);
          if (state.pinned) return;
          var tab = chip.getAttribute('data-tm-chip');
          if (!state.popoverOpen || state.activeTab !== tab) {
            state.activeTab = tab;
            state.popoverOpen = true;
            state.hoveringPopChart = false;
            renderBar();
          }
        });
        popNode.addEventListener('mouseenter', function() {
          clearTimeout(state.hoverTimer);
        });
        popNode.addEventListener('mouseleave', function() {
          state.hoveringPopChart = false;
        });
        popNode.addEventListener('pointerdown', function() {
          state.pointerInPop = true;
        });
        // 使用事件委托处理浮卡内所有按钮，避免生成中 2.5s 刷新内容时吃掉点击事件
        popNode.addEventListener('click', function(ev) {
          if (!ev || ev.isTrusted !== true) return;
          var btn = ev.target && ev.target.closest ? ev.target.closest('#tm-style-btn, #tm-copy-btn, #tm-lang-btn, #tm-open-modal') : null;
          if (!btn) return;
          var bid = btn.id;
          if (bid === 'tm-style-btn') {
            var styleNext = THEMES[(THEMES.indexOf(currentStyle()) + 1) % THEMES.length];
            state.pointerInPop = false;
            void updatePrefs({ theme: styleNext });
          } else if (bid === 'tm-copy-btn') {
            if (copyTextSafe(buildCopySummaryText())) {
              state.copiedUntil = Date.now() + 1600;
              state.pointerInPop = false;
              renderBar();
              setTimeout(function() { if (!state.disposed) renderBar(); }, 1650);
            }
          } else if (bid === 'tm-lang-btn') {
            state.pointerInPop = false;
            void updatePrefs({ language: state.prefs.language === 'en' ? 'zh-CN' : 'en' });
          } else if (bid === 'tm-open-modal') {
            clearTimeout(state.hoverTimer);
            state.pointerInPop = false;
            state.hoveringPopChart = false;
            state.popoverOpen = false;
            state.pinned = false;
            state.modalOpen = true;
            renderBar();
            renderModal();
          }
        });
        wrap.addEventListener('mouseleave', function() {
          if (state.pinned) return;
          clearTimeout(state.hoverTimer);
          state.hoverTimer = setTimeout(function() {
            state.popoverOpen = false;
            state.pointerInPop = false;
            state.hoveringPopChart = false;
            renderBar();
          }, 220);
        });
        chipsNode.addEventListener('click', function(e) {
          var chip = e.target && e.target.closest ? e.target.closest('[data-tm-chip]') : null;
          if (!chip) return;
          clearTimeout(state.hoverTimer);
          var tab = chip.getAttribute('data-tm-chip');
          if (state.pinned && state.activeTab === tab) {
            state.pinned = false;
            state.popoverOpen = false;
          } else {
            state.activeTab = tab;
            state.pinned = true;
            state.popoverOpen = true;
          }
          renderBar();
        });
      }

      var prevFree = state.freeWidth;
      if (typeof anchor.freeWidth === 'number' && Number.isFinite(anchor.freeWidth)) {
        state.freeWidth = anchor.freeWidth;
      }

      // 绑定 ResizeObserver 实时监听底栏容器缩放（包含拖动 IDE 分屏边栏缩小聊天框宽度）
      if (anchor.placement === 'inline-footer' && typeof ResizeObserver === 'function' && observedFooter !== anchor.parent) {
        try { resizeObserver && resizeObserver.disconnect(); } catch {}
        observedFooter = anchor.parent;
        resizeObserver = new ResizeObserver(function() {
          if (resizeDebounce || state.disposed) return;
          resizeDebounce = setTimeout(function() {
            resizeDebounce = null;
            ensureMounted();
            if (state.popoverOpen) positionPopover();
          }, 45);
        });
        try { resizeObserver.observe(observedFooter); } catch {}
      }

      var samePlacement = hostEl.getAttribute('data-placement') === anchor.placement;
      var alreadyPlaced =
        samePlacement &&
        hostEl.parentElement === anchor.parent &&
        (anchor.before ? hostEl.nextElementSibling === anchor.before : hostEl.nextElementSibling === null);
      if (alreadyPlaced) {
        if (Math.abs(state.freeWidth - prevFree) >= 6) renderBar();
        return;
      }

      hostEl.setAttribute('data-placement', anchor.placement);
      if (anchor.before && anchor.before.parentElement === anchor.parent) {
        anchor.parent.insertBefore(hostEl, anchor.before);
      } else {
        anchor.parent.appendChild(hostEl);
      }
      renderBar();
    }

    async function refresh() {
      if (state.disposed || !window.__agTokenMeterApi) return;
      ensureMounted();
      var cid = detectConversationId();
      if (cid !== state.lastCid) {
        state.lastCid = cid;
        state.requestSeq++;
        if (state.snapshot) state.snapshot = Object.assign({}, state.snapshot, { conversation: null, conversationUnavailable: !cid });
        renderBar();
      }
      // 即使处于新对话首页（cid 为 null）也照常拉取全局额度、今日/本月与偏好；后端 allowFallback=false 保证绝不串旧会话
      var mySeq = ++state.requestSeq;
      try {
        var snap = await window.__agTokenMeterApi.getSnapshot(cid || null);
        if (state.disposed || mySeq !== state.requestSeq || cid !== state.lastCid) return;
        if (snap && snap.disabled) {
          dispose();
          return;
        }
        if (snap) {
          state.snapshot = snap;
          if (state.prefPendingCount === 0 && snap.preferences && safeInt(snap.preferences.version) >= state.confirmedPrefVersion) {
            state.prefs = Object.assign({}, state.prefs, snap.preferences);
            state.confirmedPrefVersion = safeInt(snap.preferences.version);
          }
          renderBar();
          if (state.modalOpen) renderModal();
        }
      } catch {}
    }

    function onDocClick(e) {
      if (!state.pinned || !hostEl) return;
      var path = e.composedPath ? e.composedPath() : [];
      if (!path.includes(hostEl)) {
        state.pinned = false;
        state.popoverOpen = false;
        state.pointerInPop = false;
        renderBar();
      }
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        if (state.modalOpen) {
          state.modalOpen = false;
          renderModal();
        } else if (state.popoverOpen) {
          state.pinned = false;
          state.popoverOpen = false;
          state.pointerInPop = false;
          renderBar();
        }
      }
    }

    function onResize() {
      ensureMounted();
      if (state.popoverOpen) positionPopover();
    }

    function onScroll() {
      if (!state.popoverOpen || scrollRaf) return;
      var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function(fn) { return setTimeout(fn, 16); };
      scrollRaf = raf(function() {
        scrollRaf = 0;
        if (!state.disposed && state.popoverOpen) positionPopover();
      });
    }

    function onPointerUp() {
      state.pointerInPop = false;
    }

    function dispose() {
      state.disposed = true;
      state.barLayoutKey = '';
      state.pointerInPop = false;
      state.hoveringPopChart = false;
      state.requestSeq++;
      clearInterval(pollTimer);
      clearTimeout(mountDebounce);
      clearTimeout(resizeDebounce);
      clearTimeout(state.hoverTimer);
      if (scrollRaf) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scrollRaf);
        else clearTimeout(scrollRaf);
        scrollRaf = 0;
      }
      try { observer && observer.disconnect(); } catch {}
      try { resizeObserver && resizeObserver.disconnect(); } catch {}
      observedFooter = null;
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      if (hostEl) { hostEl.remove(); hostEl = null; shadow = null; }
      if (modalHost) { modalHost.remove(); modalHost = null; modalShadow = null; }
      delete window.__agTokenMeterMounted;
      delete window.__agTokenMeterDispose;
    }

    window.__agTokenMeterDispose = dispose;
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);

    function boot() {
      if (state.disposed) return;
      observer = new MutationObserver(function() {
        if (mountDebounce) return;
        mountDebounce = setTimeout(function() {
          mountDebounce = null;
          ensureMounted();
        }, 220);
      });
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
      ensureMounted();
      window.__agTokenMeterMounted = true;
      void refresh();
      pollTimer = setInterval(function() { void refresh(); }, 2500);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  })(${dictJson});`;
}
