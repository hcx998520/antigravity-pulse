(function () {
  const qs = new URLSearchParams(location.search);
  const uiToken = qs.get('token') || '';
  const initialCid = qs.get('conversationId') || '';

  // 握手读取后立即剥离地址栏中的敏感 token 参数，防止滞留于历史记录或 Referer
  if (uiToken && window.history && typeof window.history.replaceState === 'function') {
    qs.delete('token');
    const clean = location.pathname + (qs.toString() ? '?' + qs.toString() : '') + location.hash;
    try { window.history.replaceState(null, '', clean); } catch {}
  }

  const DICT = window.__AG_TM_I18N__ || { 'zh-CN': { diag: {} }, en: { diag: {} } };
  const THEMES = ['swiss', 'glass', 'mono'];
  let lang = 'zh-CN';
  let prefs = { language: 'zh-CN', theme: 'swiss', showSpeed: true, showCache: true, showContext: true, showQuota: true, showToday: false, showMonth: true, version: 0 };
  let confirmedVersion = 0;
  let reqSeq = 0;

  function t(k) { return (DICT[lang] && DICT[lang][k]) || (DICT['zh-CN'] && DICT['zh-CN'][k]) || k; }
  function tDiag(code) {
    const d = (DICT[lang] && DICT[lang].diag) || (DICT['zh-CN'] && DICT['zh-CN'].diag) || {};
    return d[code] || d.cdp_unreachable || String(code || '');
  }
  function safeInt(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; }
  function fmtFixed(v, digits) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(digits) : null;
  }
  function parseBaseDate(todayDate) {
    if (typeof todayDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(todayDate)) {
      const [y, m, d] = todayDate.split('-').map(Number);
      const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
      if (Number.isFinite(dt.getTime())) return dt;
    }
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    return now;
  }
  function fmtTokens(n) {
    const v = safeInt(n);
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(v);
  }
  function fmtUsd(usd) {
    const v = Number(usd);
    if (!Number.isFinite(v) || v < 0) return null;
    if (v === 0) return '$0.00';
    if (v < 0.01) return '<$0.01';
    if (v >= 1000) return '$' + (v / 1000).toFixed(2) + 'K';
    return '$' + v.toFixed(2);
  }
  function fmtPct(f) { return typeof f === 'number' && Number.isFinite(f) ? Math.round(Math.max(0, Math.min(1, f)) * 100) + '%' : '--'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtCountdown(iso) {
    if (!iso) return '--';
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms)) return '--';
    if (ms <= 0) return '0m';
    const mins = Math.floor(ms / 60000);
    const hrs = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);
    if (days > 0) return `${days}d ${hrs % 24}h`;
    if (hrs > 0) return `${hrs}h ${mins % 60}m`;
    return `${mins}m`;
  }

  /* 0%–100% 无级跟进上下文圆环（五段丰富连续色阶：翠绿 -> 天蓝 -> 琥珀 -> 70% 朱红 -> 爆满全红） */
  const CTX_RING_R = 5.6;
  const CTX_RING_CIRC = 2 * Math.PI * CTX_RING_R;
  const CTX_COLOR_STOPS = [
    [0.00, 16, 185, 129],
    [0.32, 14, 165, 233],
    [0.52, 245, 158, 11],
    [0.68, 242, 82, 46],
    [0.82, 239, 68, 68],
    [0.95, 220, 38, 38],
    [1.00, 185, 28, 28],
  ];

  function interpCtxColor(frac) {
    const f = Math.max(0, Math.min(1, Number(frac) || 0));
    for (let i = 0; i < CTX_COLOR_STOPS.length - 1; i++) {
      const a = CTX_COLOR_STOPS[i];
      const b = CTX_COLOR_STOPS[i + 1];
      if (f <= b[0]) {
        const k = (f - a[0]) / Math.max(1e-6, b[0] - a[0]);
        return `rgb(${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)},${Math.round(a[3] + (b[3] - a[3]) * k)})`;
      }
    }
    return 'rgb(185,28,28)';
  }

  function syncContextRing(container, frac) {
    if (!container) return;
    const hasVal = typeof frac === 'number' && Number.isFinite(frac);
    const clamped = hasVal ? Math.max(0, Math.min(1, frac)) : 0;
    const dashOffset = CTX_RING_CIRC * (1 - clamped);
    const stroke = interpCtxColor(clamped);

    if (!container.querySelector('.ctx-ring')) {
      container.innerHTML =
        `<svg class="ctx-ring" viewBox="0 0 16 16" aria-hidden="true">` +
          `<circle cx="8" cy="8" r="${CTX_RING_R}" fill="none" stroke="var(--ring-track)" stroke-width="1.85"/>` +
          `<circle class="ctx-ring-val" cx="8" cy="8" r="${CTX_RING_R}" fill="none" stroke="${stroke}" stroke-width="1.85" stroke-linecap="round" stroke-dasharray="${CTX_RING_CIRC.toFixed(3)}" stroke-dashoffset="${dashOffset.toFixed(3)}" stroke-opacity="${clamped > 0 ? '1' : '0'}" transform="rotate(-90 8 8)"/>` +
        `</svg>`;
      return;
    }
    const arc = container.querySelector('.ctx-ring-val');
    if (arc) {
      arc.setAttribute('stroke-dashoffset', dashOffset.toFixed(3));
      arc.setAttribute('stroke-opacity', clamped > 0 ? '1' : '0');
      arc.setAttribute('stroke', stroke);
    }
  }

  function renderSpark(points) {
    if (!Array.isArray(points) || points.length < 2) return '<div style="color:var(--faint);font-size:11.5px;padding:10px 0;text-align:center;">' + esc(t('noData')) + '</div>';
    const w = 310, h = 50, padX = 6, padY = 8;
    const vals = points.map((p) => { const v = Number(p && p.tps); return Number.isFinite(v) && v >= 0 ? v : 0; });
    const min = Math.min(...vals), max = Math.max(...vals), span = Math.max(1, max - min);
    const pts = vals.map((v, i) => [
      padX + (i / (vals.length - 1)) * (w - padX * 2),
      h - padY - ((v - min) / span) * (h - padY * 2),
    ]);
    const coords = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`);
    const area = `${padX},${h - 2} ${coords.join(' ')} ${w - padX},${h - 2}`;
    const last = pts[pts.length - 1];
    const midY = (h / 2).toFixed(1);
    const nodes = pts.slice(0, -1).map((p) =>
      `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.2" fill="var(--card)" stroke="currentColor" stroke-width="1.35"/>`
    ).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" style="display:block;overflow:visible">` +
      `<defs><linearGradient id="p-sp-area" x1="0" y1="0" x2="0" y2="${h}" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="currentColor" stop-opacity="0.10"/><stop offset="100%" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>` +
      `<line x1="0" y1="${midY}" x2="${w}" y2="${midY}" stroke="var(--hairline)" stroke-dasharray="2 3"/>` +
      `<polygon points="${area}" fill="url(#p-sp-area)"/><polyline points="${coords.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` +
      nodes +
      `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="5" fill="var(--accent)" fill-opacity="0.16"/>` +
      `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.9" fill="var(--accent)" stroke="var(--card)" stroke-width="1.5"/></svg>`;
  }

  async function apiGet(path) {
    const headers = {};
    if (uiToken) headers['x-sidecar-token'] = uiToken;
    const r = await fetch(path, { cache: 'no-store', headers });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function apiPost(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (uiToken) headers['x-sidecar-token'] = uiToken;
    const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  function renderToggles() {
    const items = [
      ['showSpeed', t('optSpeed')], ['showCache', t('optCache')],
      ['showContext', t('optContext')], ['showQuota', t('optQuota')],
      ['showToday', t('optToday')], ['showMonth', t('optMonth')],
    ];
    const box = document.getElementById('toggles');
    box.innerHTML = items.map(([k, label]) => {
      const on = Boolean(prefs[k]);
      return `<label class="pill ${on ? 'on' : ''}"><input type="checkbox" data-k="${esc(k)}" ${on ? 'checked' : ''}/><span class="pill-dot"></span>${esc(label)}</label>`;
    }).join('');
    box.querySelectorAll('input').forEach((inp) => {
      inp.onchange = async () => {
        try {
          const next = await apiPost('./api/preferences', { [inp.dataset.k]: inp.checked });
          if (next && !next.error) {
            prefs = next;
            confirmedVersion = Math.max(confirmedVersion, safeInt(next.version));
            renderToggles();
          }
        } catch {
          inp.checked = !inp.checked;
        }
      };
    });
  }

  function renderThemeSeg() {
    const cur = THEMES.includes(prefs.theme) ? prefs.theme : 'swiss';
    document.documentElement.setAttribute('data-style', cur);
    const seg = document.getElementById('theme-seg');
    if (!seg) return;
    const list = [
      ['swiss', t('themeSwiss')],
      ['glass', t('themeGlass')],
      ['mono', t('themeMono')],
    ];
    seg.innerHTML = list.map(([id, lbl]) => `<button type="button" class="${cur === id ? 'active' : ''}" data-th="${id}">${esc(lbl)}</button>`).join('');
    seg.querySelectorAll('button').forEach((btn) => {
      btn.onclick = async () => {
        try {
          const next = await apiPost('./api/preferences', { theme: btn.dataset.th });
          if (next && !next.error) {
            prefs = next;
            confirmedVersion = Math.max(confirmedVersion, safeInt(next.version));
            renderThemeSeg();
          }
        } catch {}
      };
    });
  }

  function applyStaticLabels() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-k]').forEach((el) => { el.textContent = t(el.dataset.k); });
    document.getElementById('lang-btn').textContent = lang === 'en' ? '中文' : 'EN';
    document.getElementById('refresh-btn').textContent = t('refresh');
    document.getElementById('quota-legend').textContent = t('paceLegend');
    renderThemeSeg();
  }

  function renderHeatmap(days, todayDate) {
    const dayMap = Object.create(null);
    (days || []).forEach((d) => {
      if (d && d.date) dayMap[d.date] = safeInt(d.total);
    });
    const now = parseBaseDate(todayDate);
    const todayDow = now.getDay(); // 0=周日..6=周六，按真实星期对齐不跨天错位
    const totalCols = 22;
    const cell = 11, gap = 3, step = cell + gap;
    const w = totalCols * step - gap;
    const h = 7 * step - gap;
    const cells = [];
    let visibleMax = 1;
    for (let c = 0; c < totalCols; c++) {
      for (let r = 0; r < 7; r++) {
        const offsetDays = (totalCols - 1 - c) * 7 + (todayDow - r);
        if (offsetDays < 0) continue;
        const dt = new Date(now);
        dt.setDate(dt.getDate() - offsetDays);
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        const val = dayMap[key] || 0;
        if (val > visibleMax) visibleMax = val;
        cells.push({ x: c * step, y: r * step, key, val });
      }
    }
    const rects = cells.map((it) => {
      const cls = it.val <= 0 ? 'h-c0' : it.val > visibleMax * 0.72 ? 'h-c4' : it.val > visibleMax * 0.40 ? 'h-c3' : it.val > visibleMax * 0.14 ? 'h-c2' : 'h-c1';
      return `<rect x="${it.x}" y="${it.y}" width="${cell}" height="${cell}" rx="2.4" class="${cls}"><title>${esc(`${it.key}: ${fmtTokens(it.val)} tokens`)}</title></rect>`;
    }).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet">${rects}</svg>`;
  }

  function renderSubBar(tag, frac, resetIso, pacing) {
    const pct = Math.round(Math.max(0, Math.min(1, Number(frac) || 0)) * 100);
    const status = pacing && pacing.status;
    const cls = (pct <= 15 || status === 'burn') ? 'danger' : (pct <= 35 || status === 'fast') ? 'warn' : '';
    let tick = '';
    if (pacing && typeof pacing.timeRemainingFraction === 'number' && Number.isFinite(pacing.timeRemainingFraction)) {
      const pos = Math.max(2, Math.min(98, Math.round(pacing.timeRemainingFraction * 100)));
      tick = `<span class="q-tick" style="left:${pos}%" title="${esc(t('paceLegend'))}"></span>`;
    }
    return `<div class="q-sub"><span class="q-tag">${esc(tag)}</span><div class="q-track"><div class="q-bar"><div class="q-fill ${cls}" style="width:${pct}%"></div></div>${tick}</div><span class="q-sub-val"><b>${pct}%</b><em>${esc(fmtCountdown(resetIso))}</em></span></div>`;
  }

  async function refresh() {
    if (document.hidden) return;
    const mySeq = ++reqSeq;
    try {
      const q = initialCid ? `?conversationId=${encodeURIComponent(initialCid)}` : '';
      const data = await apiGet('./api/snapshot' + q);
      if (mySeq !== reqSeq) return;

      if (data.version) document.getElementById('ver').textContent = 'v' + String(data.version);
      if (data.preferences && safeInt(data.preferences.version) >= confirmedVersion) {
        prefs = data.preferences;
        confirmedVersion = safeInt(prefs.version);
        lang = prefs.language === 'en' ? 'en' : 'zh-CN';
      }
      applyStaticLabels();

      const diag = data.integration || {};
      const banner = document.getElementById('diag-banner');
      const ok = diag.state === 'mounted' || diag.state === 'waiting_composer';
      banner.className = 'banner ' + (ok ? 'ok' : 'warn');
      banner.textContent = (ok ? '' : '⚠ ') + tDiag(diag.code || diag.state);

      const c = data.conversation || {};
      const heroSpeed = fmtFixed(c.latestTps, 1) || fmtFixed(c.tps, 1) || '--';
      document.getElementById('k-latest').textContent = heroSpeed;
      document.getElementById('k-session').textContent = fmtFixed(c.tps, 1) || '--';
      document.getElementById('k-cache').textContent = fmtPct(c.cacheHitRate);
      const ctxFrac = c.context ? c.context.usedFraction : null;
      syncContextRing(document.getElementById('k-ctx-ring'), ctxFrac);
      document.getElementById('k-ctx').textContent = c.context ? fmtPct(ctxFrac) : '--';
      document.getElementById('model-name').textContent = c.model || (data.conversationUnavailable ? t('convUnavailable') : '');
      document.getElementById('sparkline').innerHTML = renderSpark(c.sparkline);

      const quotas = data.quotas || [];
      document.getElementById('quotas').innerHTML = quotas.length
        ? quotas.map((item) => {
            if (item.fiveHour && item.weekly) {
              const p5 = Math.round(Math.max(0, Math.min(1, Number(item.fiveHour.remainingFraction) || 0)) * 100);
              const pw = Math.round(Math.max(0, Math.min(1, Number(item.weekly.remainingFraction) || 0)) * 100);
              return `<div class="q-item"><div class="q-meta"><span class="q-name">${esc(item.title)}</span><span class="q-pair" title="${esc(t('quotaPairTip'))}">${p5}%<span class="q-slash">/</span>${pw}%</span></div>` +
                renderSubBar(t('quotaTag5h'), item.fiveHour.remainingFraction, item.fiveHour.resetTime, item.fiveHour.pacing) +
                renderSubBar(t('quotaTagWeek'), item.weekly.remainingFraction, item.weekly.resetTime, item.weekly.pacing) +
              `</div>`;
            }
            let kind = item.windowKind === '5h' || item.windowKind === 'week' ? item.windowKind : null;
            if (!kind && item.resetTime) {
              const ms = Date.parse(item.resetTime) - Date.now();
              if (Number.isFinite(ms) && ms > 0) kind = ms <= 5.5 * 3600000 ? '5h' : ms <= 8 * 86400000 ? 'week' : null;
            }
            const tag = kind ? (kind === '5h' ? t('quotaTag5h') : t('quotaTagWeek')) : '·';
            return `<div class="q-item"><div class="q-meta"><span class="q-name">${esc(item.title)}</span></div>${renderSubBar(tag, item.remainingFraction, item.resetTime, item.pacing)}</div>`;
          }).join('')
        : `<div style="color:var(--faint);font-size:11.5px;">${esc(t('noData'))}</div>`;

      const usage = data.usage || {};
      document.getElementById('u-today').textContent = fmtTokens(usage.todayTokens);
      document.getElementById('u-week').textContent = fmtTokens(usage.weekTokens);
      document.getElementById('u-month').textContent = fmtTokens(usage.monthTokens);
      document.getElementById('u-total').textContent = fmtTokens(usage.totalTokens);
      const uMetaEl = document.getElementById('u-meta');
      if (uMetaEl) {
        const metaParts = [];
        const totalCostStr = fmtUsd(usage.totalCostUsd);
        if (totalCostStr) metaParts.push(totalCostStr);
        if (safeInt(usage.monthRequests) > 0) metaParts.push(`${safeInt(usage.monthRequests).toLocaleString()} ${t('requests')}`);
        if (safeInt(usage.activeDays) > 0) metaParts.push(`${safeInt(usage.activeDays)} ${t('activeDays')}`);
        uMetaEl.textContent = metaParts.join(' · ');
      }
      const heatEl = document.getElementById('heatmap');
      if (heatEl) heatEl.innerHTML = renderHeatmap(usage.days, usage.todayDate);
      const savedStr = fmtUsd(usage.lifetimeCacheSavingsUsd);
      document.getElementById('today-sum').textContent = `${t('lifetime')} ${fmtTokens(usage.totalTokens)}` + (savedStr ? ` · ${t('costSaved')} ${savedStr}` : '');
      const ranks = usage.modelRank || [];
      const tbody = document.getElementById('rank-body');
      tbody.textContent = '';
      if (!ranks.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.style.color = 'var(--faint)';
        td.style.textAlign = 'center';
        td.textContent = t('noData');
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        for (const m of ranks) {
          const tr = document.createElement('tr');
          const tdModel = document.createElement('td');
          const nameSpan = document.createElement('span');
          nameSpan.textContent = String(m.model || '');
          tdModel.appendChild(nameSpan);
          if (m.pricing) {
            const rateSpan = document.createElement('span');
            rateSpan.className = 'rate-sub';
            rateSpan.textContent = `$${m.pricing.inputPer1M}/$${m.pricing.cacheReadPer1M}/$${m.pricing.outputPer1M}`;
            tdModel.appendChild(rateSpan);
          }
          tr.appendChild(tdModel);

          const tdTot = document.createElement('td');
          tdTot.textContent = fmtTokens(m.totalTokens);
          const mCostStr = fmtUsd(m.costUsd);
          if (mCostStr) {
            const cSpan = document.createElement('span');
            cSpan.className = 'cost-sub';
            cSpan.textContent = mCostStr;
            tdTot.appendChild(cSpan);
          }
          tr.appendChild(tdTot);

          for (const cellText of [
            fmtFixed(m.avgTps, 1) || '--',
            String(safeInt(m.requests)),
          ]) {
            const td = document.createElement('td');
            td.textContent = cellText;
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
      }

      renderToggles();
    } catch {
      if (mySeq !== reqSeq) return;
      const banner = document.getElementById('diag-banner');
      banner.className = 'banner warn';
      banner.textContent = '⚠ ' + t('fetchError');
    }
  }

  document.getElementById('refresh-btn').onclick = () => void refresh();
  document.getElementById('lang-btn').onclick = async () => {
    try {
      const next = await apiPost('./api/preferences', { language: lang === 'en' ? 'zh-CN' : 'en' });
      if (next && !next.error) {
        prefs = next;
        confirmedVersion = Math.max(confirmedVersion, safeInt(next.version));
        lang = prefs.language;
        void refresh();
      }
    } catch {}
  };

  applyStaticLabels();
  void refresh();
  setInterval(() => void refresh(), 3000);
})();
