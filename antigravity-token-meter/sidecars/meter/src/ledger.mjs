/**
 * 并发安全、防原型污染、全维度精确对账的本地持久化 Token 用量账本。
 *
 * 工程保障：
 * 1. 所有动态索引容器使用无原型对象（Object.create(null)）重建，彻底杜绝 __proto__/constructor 原型污染；
 * 2. 首次 load 共享单一 loadPromise；严格区分 ENOENT（初始化）与损坏文件（保留磁盘原件不静默覆盖）；
 * 3. 支持按事件 ID 差值 upsert（流式中间快照变完整最终态时自动重算完整步费率差值，完美跨越 >200k 长上下文阈值，零重复零漏记）；
 * 4. 使用单调 revision / committedRevision 驱动循环原子落盘（随机临时文件 + rename），杜绝并发丢写；
 * 5. 按日分模型明细（byModelDetail）与按模型汇总双轨同步记账，并对旧版 ledger-v1.json 历史数据执行确定性分量守恒水合（IPF），
 *    确保按日、按周、按月、按模型与累计总费用 100% 严丝合缝对账，且历史月份费率锁定不因未来调价而追溯翻倍。
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { computeTokenCost, getModelPricing, roundUsd } from './pricing.mjs';

const MAX_RECORDS = 10000;
const MAX_DAYS = 400;
const MAX_APPLIED_IMPORTS = 64;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function safeInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(n)) : 0;
}

function safeFloat(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function hasValidNonNegNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * 将 Date、时间戳或 ISO 字符串转换为本地日历日键（YYYY-MM-DD）。
 * 若输入本身已是合法的 YYYY-MM-DD 日历日字符串，直接按本地日历日保留，严防在 UTC-X 时区因 new Date("YYYY-MM-DD") 按 UTC 午夜解析而往前错位一天。
 */
export function toLocalDateKey(input = new Date()) {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const m = trimmed.match(DATE_KEY_RE);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const da = Number(m[3]);
      const localCheck = new Date(y, mo - 1, da, 12, 0, 0, 0);
      if (
        Number.isFinite(localCheck.getTime()) &&
        localCheck.getFullYear() === y &&
        localCheck.getMonth() === mo - 1 &&
        localCheck.getDate() === da
      ) {
        return trimmed;
      }
    }
  }
  const d = input instanceof Date ? input : new Date(input);
  const valid = Number.isFinite(d.getTime()) ? d : new Date();
  return `${valid.getFullYear()}-${String(valid.getMonth() + 1).padStart(2, '0')}-${String(valid.getDate()).padStart(2, '0')}`;
}

/**
 * 解析 YYYY-MM-DD 为当日 UTC 正午毫秒时间戳（用于无精确毫秒时间戳的历史日桶费率阶段判定）。
 */
function parseDateRateTsMs(dateKey, fallbackMs = Date.now()) {
  if (typeof dateKey === 'string' && DATE_KEY_RE.test(dateKey)) {
    const ms = Date.parse(`${dateKey}T12:00:00Z`);
    if (Number.isFinite(ms)) return ms;
  }
  return fallbackMs;
}

/**
 * 解析 YYYY-MM-DD 为本地零点毫秒时间戳（供无毫秒时间戳旧记录的 FIFO 驱逐下界使用，避免误伤同日或次日凌晨新事件）。
 */
function parseLocalMidnightMs(dateKey) {
  if (typeof dateKey !== 'string') return 0;
  const m = dateKey.match(DATE_KEY_RE);
  if (!m) return 0;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isFinite(dt.getTime()) ? dt.getTime() : 0;
}

function createEmptyState() {
  return {
    schema: 2,
    lifetimeTotal: 0,
    lifetimeCostUsd: 0,
    lifetimeCacheSavingsUsd: 0,
    importedUntil: null,
    evictedUntil: null,
    appliedImports: [],
    recordOrder: [],
    records: Object.create(null),
    days: Object.create(null),
    models: Object.create(null),
    updatedAt: null,
  };
}

function createEmptyModelDetail() {
  return {
    total: 0,
    input: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
    requests: 0,
    costUsd: 0,
    cacheSavingsUsd: 0,
  };
}

function createEmptyModelStats() {
  return {
    total: 0,
    input: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
    requests: 0,
    timedOutput: 0,
    streamingSec: 0,
    costUsd: 0,
    cacheSavingsUsd: 0,
  };
}

/**
 * 兼容 Windows 瞬时文件句柄占用的原子替换重试辅助函数。
 */
async function renameWithRetry(tmpPath, dstPath, maxAttempts = 4) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await rename(tmpPath, dstPath);
      return;
    } catch (err) {
      const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
      if (!transient || i === maxAttempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
}

/**
 * 构建各模型的历史全局 Token 分量先验比例，供旧版无分模型明细的混合历史日桶进行分量守恒归因。
 */
function buildModelPriors(modelsMap) {
  const priors = Object.create(null);
  if (!modelsMap || typeof modelsMap !== 'object') return priors;
  for (const [mName, m] of Object.entries(modelsMap)) {
    if (!m || typeof m !== 'object') continue;
    const uIn = safeInt(m.input);
    const cRead = safeInt(m.cacheRead);
    const out = Math.max(safeInt(m.output), safeInt(m.thinking));
    const sum = uIn + cRead + out;
    if (sum > 0) {
      priors[mName] = {
        inFrac: uIn / sum,
        crFrac: cRead / sum,
        outFrac: out / sum,
        avgReqsPerToken: safeInt(m.requests) > 0 ? safeInt(m.requests) / sum : 0,
      };
    }
  }
  return priors;
}

/**
 * 对旧版缺少 byModelDetail 的历史日桶执行确定性分量守恒拆解（Sinkhorn / IPF 双向比例拟合），
 * 严格满足：
 * 1. 单模型日 100% 还原当日真实 (input, cacheRead, output, requests)；
 * 2. 多模型混用日每个模型的 in + cr + out === byModel[m]，且所有模型之和贴合当日真实的 (entry.input, entry.cacheRead, entry.output)；
 * 3. 按该历史日的日期费率计算各模型的精确 costUsd 与 cacheSavingsUsd。
 */
function hydrateLegacyDayEntry(dateKey, dayEntry, modelPriors, dateRecords = null) {
  const dTotal = safeInt(dayEntry.total);
  const dIn = safeInt(dayEntry.input);
  const dCr = safeInt(dayEntry.cacheRead);
  const dOut = safeInt(dayEntry.output);
  const dReqs = safeInt(dayEntry.requests);
  const rateTsMs = parseDateRateTsMs(dateKey);

  // 优先检查单步 records 是否恰好 100% 覆盖当日全部消费（如近期活跃日），可直接无损还原单步级 >200k 阶梯与精确时间戳费用
  if (Array.isArray(dateRecords) && dateRecords.length > 0 && dTotal > 0) {
    let rTot = 0;
    let rIn = 0;
    let rCr = 0;
    let rOut = 0;
    const detailFromRecs = Object.create(null);
    for (const rec of dateRecords) {
      const recTot = rec.input + rec.cacheRead + rec.output;
      rTot += recTot;
      rIn += rec.input;
      rCr += rec.cacheRead;
      rOut += rec.output;
      if (!Object.hasOwn(detailFromRecs, rec.model)) {
        detailFromRecs[rec.model] = createEmptyModelDetail();
      }
      const det = detailFromRecs[rec.model];
      det.total += recTot;
      det.input += rec.input;
      det.cacheRead += rec.cacheRead;
      det.output += rec.output;
      det.thinking += rec.thinking;
      det.requests += 1;
      det.costUsd += rec.costUsd;
      det.cacheSavingsUsd += rec.cacheSavingsUsd;
    }
    if (rTot === dTotal && rIn === dIn && rCr === dCr && rOut === dOut) {
      let sumCost = 0;
      let sumSavings = 0;
      for (const det of Object.values(detailFromRecs)) {
        det.costUsd = roundUsd(det.costUsd);
        det.cacheSavingsUsd = roundUsd(det.cacheSavingsUsd);
        sumCost += det.costUsd;
        sumSavings += det.cacheSavingsUsd;
      }
      dayEntry.byModelDetail = detailFromRecs;
      dayEntry.costUsd = roundUsd(sumCost);
      dayEntry.cacheSavingsUsd = roundUsd(sumSavings);
      dayEntry.unattributedTokens = 0;
      dayEntry.unattributedCostUsd = 0;
      dayEntry.unattributedSavingsUsd = 0;
      return;
    }
  }

  const byModelDetail = Object.create(null);
  const rawItems = [];
  let attributedTotal = 0;
  if (dayEntry.byModel && typeof dayEntry.byModel === 'object') {
    for (const [mKey, mVal] of Object.entries(dayEntry.byModel)) {
      const v = safeInt(mVal);
      if (v > 0) {
        rawItems.push([String(mKey), v]);
        attributedTotal += v;
      }
    }
  }

  if (dTotal <= 0 && attributedTotal <= 0) {
    dayEntry.byModelDetail = byModelDetail;
    dayEntry.costUsd = 0;
    dayEntry.cacheSavingsUsd = 0;
    dayEntry.unattributedTokens = 0;
    dayEntry.unattributedCostUsd = 0;
    dayEntry.unattributedSavingsUsd = 0;
    return;
  }

  // 若当日存在未归入 byModel 的历史孤立余量，纳入联合分摊以保证当日总盘守恒，但不污染原有 byModel 键集合
  const unattributedTokens = Math.max(0, dTotal - attributedTotal);
  const rows = rawItems.map(([name, vol]) => ({ name, vol, isUnattributed: false }));
  if (unattributedTokens > 0) {
    rows.push({ name: 'Default Reference', vol: unattributedTokens, isUnattributed: true });
  }

  const totalVol = rows.reduce((acc, r) => acc + r.vol, 0);
  const compSum = dIn + dCr + dOut;
  const targetIn = compSum > 0 ? dIn * (totalVol / compSum) : totalVol * 0.05;
  const targetCr = compSum > 0 ? dCr * (totalVol / compSum) : totalVol * 0.90;
  const targetOut = compSum > 0 ? dOut * (totalVol / compSum) : totalVol * 0.05;

  const dayInFrac = totalVol > 0 ? targetIn / totalVol : 0.05;
  const dayCrFrac = totalVol > 0 ? targetCr / totalVol : 0.90;
  const dayOutFrac = totalVol > 0 ? targetOut / totalVol : 0.05;

  let matrix;
  if (rows.length === 1) {
    matrix = [[targetIn, targetCr, targetOut]];
  } else {
    matrix = rows.map((r) => {
      const p = !r.isUnattributed ? modelPriors[r.name] : null;
      const pIn = p ? p.inFrac + 1e-9 : dayInFrac + 1e-9;
      const pCr = p ? p.crFrac + 1e-9 : dayCrFrac + 1e-9;
      const pOut = p ? p.outFrac + 1e-9 : dayOutFrac + 1e-9;
      const pNorm = pIn + pCr + pOut;
      return [
        targetIn === 0 ? 0 : r.vol * (pIn / pNorm),
        targetCr === 0 ? 0 : r.vol * (pCr / pNorm),
        targetOut === 0 ? 0 : r.vol * (pOut / pNorm),
      ];
    });

    const targets = [targetIn, targetCr, targetOut];
    for (let iter = 0; iter < 8; iter++) {
      // 列缩放：贴合当日真实 input / cacheRead / output
      for (let c = 0; c < 3; c++) {
        const tgt = targets[c];
        if (tgt <= 0) {
          for (let r = 0; r < rows.length; r++) matrix[r][c] = 0;
          continue;
        }
        let colSum = 0;
        for (let r = 0; r < rows.length; r++) colSum += matrix[r][c];
        if (colSum > 0) {
          const scale = tgt / colSum;
          for (let r = 0; r < rows.length; r++) matrix[r][c] *= scale;
        } else {
          for (let r = 0; r < rows.length; r++) matrix[r][c] = tgt * (rows[r].vol / totalVol);
        }
      }
      // 行缩放：严格对齐每个模型当日总 Token
      for (let r = 0; r < rows.length; r++) {
        const rowSum = matrix[r][0] + matrix[r][1] + matrix[r][2];
        const vol = rows[r].vol;
        if (rowSum > 0) {
          const scale = vol / rowSum;
          matrix[r][0] *= scale;
          matrix[r][1] *= scale;
          matrix[r][2] *= scale;
        } else {
          matrix[r][0] = vol * dayInFrac;
          matrix[r][1] = vol * dayCrFrac;
          matrix[r][2] = vol * dayOutFrac;
        }
      }
    }
  }

  let dayCostUsd = 0;
  let daySavingsUsd = 0;
  let unattributedCostUsd = 0;
  let unattributedSavingsUsd = 0;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const [mIn, mCr, mOut] = matrix[r];
    const prior = !row.isUnattributed ? modelPriors[row.name] : null;
    const estReqs = rows.length === 1 && dReqs > 0
      ? dReqs
      : dReqs > 0
        ? Math.max(1, Math.round(dReqs * (row.vol / totalVol)))
        : prior && prior.avgReqsPerToken > 0
          ? Math.max(1, Math.round(row.vol * prior.avgReqsPerToken))
          : undefined;

    const c = computeTokenCost({
      model: row.name,
      inputTokens: mIn,
      cacheReadTokens: mCr,
      outputTokens: mOut,
      requests: estReqs,
    }, rateTsMs);

    if (row.isUnattributed) {
      unattributedCostUsd += c.costUsd;
      unattributedSavingsUsd += c.cacheSavingsUsd;
    } else {
      byModelDetail[row.name] = {
        total: row.vol,
        input: Math.round(mIn),
        cacheRead: Math.round(mCr),
        output: Math.max(0, row.vol - Math.round(mIn) - Math.round(mCr)),
        thinking: 0,
        requests: estReqs || 0,
        costUsd: c.costUsd,
        cacheSavingsUsd: c.cacheSavingsUsd,
      };
    }
    dayCostUsd += c.costUsd;
    daySavingsUsd += c.cacheSavingsUsd;
  }

  dayEntry.byModelDetail = byModelDetail;
  dayEntry.costUsd = roundUsd(dayCostUsd);
  dayEntry.cacheSavingsUsd = roundUsd(daySavingsUsd);
  dayEntry.unattributedTokens = unattributedTokens;
  dayEntry.unattributedCostUsd = roundUsd(unattributedCostUsd);
  dayEntry.unattributedSavingsUsd = roundUsd(unattributedSavingsUsd);
}

/**
 * 确保整个账本状态的所有日桶、模型桶与累计美元金额在内存中 100% 闭合对账。
 */
function reconcileStateCosts(state, { preservePersistedModelCosts = false } = {}) {
  const modelPriors = buildModelPriors(state.models);
  const recordsByDate = Object.create(null);
  for (const id of state.recordOrder) {
    const rec = Object.hasOwn(state.records, id) ? state.records[id] : null;
    if (!rec) continue;
    if (!Object.hasOwn(recordsByDate, rec.dateKey)) recordsByDate[rec.dateKey] = [];
    recordsByDate[rec.dateKey].push(rec);
  }

  const sortedDays = Object.keys(state.days).sort();
  const earliestDayTs = sortedDays.length > 0
    ? parseDateRateTsMs(sortedDays[0])
    : state.importedUntil && Number.isFinite(Date.parse(state.importedUntil))
      ? Date.parse(state.importedUntil)
      : Date.now();

  const dayAggByModel = Object.create(null);
  let totalUnattributedCost = 0;
  let totalUnattributedSavings = 0;

  for (const dateKey of sortedDays) {
    const d = state.days[dateKey];
    let hasCompleteDetail = false;
    if (d.byModelDetail && typeof d.byModelDetail === 'object') {
      let detailSum = 0;
      for (const det of Object.values(d.byModelDetail)) {
        detailSum += safeInt(det?.total);
      }
      const coveredSum = detailSum + safeInt(d.unattributedTokens);
      if (coveredSum === d.total && (d.total > 0 || Object.keys(d.byModel || {}).length === 0)) {
        hasCompleteDetail = true;
      }
    }

    if (!hasCompleteDetail) {
      hydrateLegacyDayEntry(dateKey, d, modelPriors, recordsByDate[dateKey] || null);
    } else {
      let sumC = roundUsd(d.unattributedCostUsd || 0);
      let sumS = roundUsd(d.unattributedSavingsUsd || 0);
      const rateTsMs = parseDateRateTsMs(dateKey);
      for (const [mName, det] of Object.entries(d.byModelDetail)) {
        if (!hasValidNonNegNumber(det.costUsd)) {
          const c = computeTokenCost({
            model: mName,
            inputTokens: safeInt(det.input),
            cacheReadTokens: safeInt(det.cacheRead),
            outputTokens: Math.max(safeInt(det.output), safeInt(det.thinking)),
            requests: safeInt(det.requests) || undefined,
          }, rateTsMs);
          det.costUsd = c.costUsd;
          det.cacheSavingsUsd = c.cacheSavingsUsd;
        } else {
          det.costUsd = roundUsd(det.costUsd);
          det.cacheSavingsUsd = roundUsd(det.cacheSavingsUsd);
        }
        sumC += det.costUsd;
        sumS += det.cacheSavingsUsd;
      }
      d.costUsd = roundUsd(sumC);
      d.cacheSavingsUsd = roundUsd(sumS);
    }

    totalUnattributedCost += roundUsd(d.unattributedCostUsd || 0);
    totalUnattributedSavings += roundUsd(d.unattributedSavingsUsd || 0);

    for (const [mName, det] of Object.entries(d.byModelDetail || {})) {
      if (!Object.hasOwn(dayAggByModel, mName)) {
        dayAggByModel[mName] = { total: 0, input: 0, cacheRead: 0, output: 0, requests: 0, costUsd: 0, cacheSavingsUsd: 0 };
      }
      const agg = dayAggByModel[mName];
      agg.total += safeInt(det.total);
      agg.input += safeInt(det.input);
      agg.cacheRead += safeInt(det.cacheRead);
      agg.output += safeInt(det.output);
      agg.requests += safeInt(det.requests);
      agg.costUsd += roundUsd(det.costUsd);
      agg.cacheSavingsUsd += roundUsd(det.cacheSavingsUsd);
    }
  }

  // 若日桶中存在但 models 表中缺失的模型（如边缘历史导入），自动补齐以维持对账闭合
  for (const [mName, agg] of Object.entries(dayAggByModel)) {
    if (!Object.hasOwn(state.models, mName) && agg.total > 0) {
      state.models[mName] = {
        total: agg.total,
        input: agg.input,
        cacheRead: agg.cacheRead,
        output: agg.output,
        thinking: 0,
        requests: agg.requests,
        timedOutput: 0,
        streamingSec: 0,
        costUsd: roundUsd(agg.costUsd),
        cacheSavingsUsd: roundUsd(agg.cacheSavingsUsd),
      };
    }
  }

  let sumModelsCost = 0;
  let sumModelsSavings = 0;
  for (const [mName, m] of Object.entries(state.models)) {
    const agg = dayAggByModel[mName];
    if (preservePersistedModelCosts && hasValidNonNegNumber(m._persistedCostUsd)) {
      m.costUsd = roundUsd(m._persistedCostUsd);
      m.cacheSavingsUsd = roundUsd(m._persistedSavingsUsd || 0);
    } else {
      let mCost = agg ? agg.costUsd : 0;
      let mSav = agg ? agg.cacheSavingsUsd : 0;
      const coveredTokens = agg ? agg.total : 0;
      if (m.total > coveredTokens) {
        // 超出 400 天滚动日桶被淘汰的早期历史差额：按最早已知日期费率与剩余分量补算
        const remTot = m.total - coveredTokens;
        const frac = m.total > 0 ? remTot / m.total : 0;
        const remIn = agg ? Math.max(0, m.input - agg.input) : m.input;
        const remCr = agg ? Math.max(0, m.cacheRead - agg.cacheRead) : m.cacheRead;
        const remOut = agg ? Math.max(0, Math.max(m.output, m.thinking) - agg.output) : Math.max(m.output, m.thinking);
        const remReqs = agg ? Math.max(1, m.requests - agg.requests) : (m.requests || undefined);
        const remSum = remIn + remCr + remOut;
        const c = computeTokenCost({
          model: mName,
          inputTokens: remSum > 0 ? remIn : m.input * frac,
          cacheReadTokens: remSum > 0 ? remCr : m.cacheRead * frac,
          outputTokens: remSum > 0 ? remOut : Math.max(m.output, m.thinking) * frac,
          requests: remReqs,
        }, earliestDayTs);
        mCost += c.costUsd;
        mSav += c.cacheSavingsUsd;
      }
      m.costUsd = roundUsd(mCost);
      m.cacheSavingsUsd = roundUsd(mSav);
    }
    delete m._persistedCostUsd;
    delete m._persistedSavingsUsd;
    sumModelsCost += m.costUsd;
    sumModelsSavings += m.cacheSavingsUsd;
  }

  const computedLifetimeCost = roundUsd(sumModelsCost + totalUnattributedCost);
  const computedLifetimeSavings = roundUsd(sumModelsSavings + totalUnattributedSavings);
  if (preservePersistedModelCosts && hasValidNonNegNumber(state._persistedLifetimeCostUsd)) {
    state.lifetimeCostUsd = roundUsd(Math.max(state._persistedLifetimeCostUsd, computedLifetimeCost));
    state.lifetimeCacheSavingsUsd = roundUsd(Math.max(state._persistedLifetimeSavingsUsd || 0, computedLifetimeSavings));
  } else {
    state.lifetimeCostUsd = computedLifetimeCost;
    state.lifetimeCacheSavingsUsd = computedLifetimeSavings;
  }
  delete state._persistedLifetimeCostUsd;
  delete state._persistedLifetimeSavingsUsd;
}

function rebuildSafeState(parsed) {
  const next = createEmptyState();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.schema !== 2) return null;
  // 严格校验核心顶层结构，残缺或类型损坏的 schema:2 一律拒绝并保留原文件
  if (
    !Number.isSafeInteger(parsed.lifetimeTotal) || parsed.lifetimeTotal < 0 ||
    !parsed.days || typeof parsed.days !== 'object' || Array.isArray(parsed.days) ||
    !parsed.models || typeof parsed.models !== 'object' || Array.isArray(parsed.models) ||
    !Array.isArray(parsed.recordOrder) ||
    !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)
  ) {
    return null;
  }

  next.lifetimeTotal = safeInt(parsed.lifetimeTotal);
  if (hasValidNonNegNumber(parsed.lifetimeCostUsd)) {
    next._persistedLifetimeCostUsd = roundUsd(parsed.lifetimeCostUsd);
    next._persistedLifetimeSavingsUsd = roundUsd(parsed.lifetimeCacheSavingsUsd || 0);
  }
  next.importedUntil = typeof parsed.importedUntil === 'string' && Number.isFinite(Date.parse(parsed.importedUntil))
    ? parsed.importedUntil
    : null;
  next.evictedUntil = typeof parsed.evictedUntil === 'string' && Number.isFinite(Date.parse(parsed.evictedUntil))
    ? parsed.evictedUntil
    : null;
  if (Array.isArray(parsed.appliedImports)) {
    next.appliedImports = parsed.appliedImports
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => v.trim().slice(0, 80))
      .slice(-MAX_APPLIED_IMPORTS);
  }
  next.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;

  let allModelsHaveCost = hasValidNonNegNumber(parsed.lifetimeCostUsd);
  if (parsed.models && typeof parsed.models === 'object' && !Array.isArray(parsed.models)) {
    for (const [mKey, m] of Object.entries(parsed.models)) {
      if (!m || typeof m !== 'object') continue;
      const safeKey = String(mKey).slice(0, 128);
      const thinking = safeInt(m.thinking);
      const output = Math.max(safeInt(m.output), thinking);
      const item = {
        total: safeInt(m.total),
        input: safeInt(m.input),
        cacheRead: safeInt(m.cacheRead),
        output,
        thinking,
        requests: safeInt(m.requests),
        timedOutput: safeInt(m.timedOutput),
        streamingSec: safeFloat(m.streamingSec),
        costUsd: 0,
        cacheSavingsUsd: 0,
      };
      if (hasValidNonNegNumber(m.costUsd)) {
        item._persistedCostUsd = roundUsd(m.costUsd);
        item._persistedSavingsUsd = roundUsd(m.cacheSavingsUsd || 0);
      } else if (item.total > 0) {
        allModelsHaveCost = false;
      }
      next.models[safeKey] = item;
    }
  }

  if (Array.isArray(parsed.recordOrder) && parsed.records && typeof parsed.records === 'object') {
    for (const rawId of parsed.recordOrder.slice(-MAX_RECORDS)) {
      const id = String(rawId);
      const rec = Object.hasOwn(parsed.records, id) ? parsed.records[id] : null;
      if (!rec || typeof rec !== 'object') continue;
      const dateKey = typeof rec.dateKey === 'string' && DATE_KEY_RE.test(rec.dateKey) ? rec.dateKey : toLocalDateKey();
      const ts = safeInt(rec.ts);
      const model = String(rec.model || 'Unknown').slice(0, 128);
      const input = safeInt(rec.input);
      const cacheRead = safeInt(rec.cacheRead);
      const thinking = safeInt(rec.thinking);
      const output = Math.max(safeInt(rec.output), thinking);
      let costUsd;
      let cacheSavingsUsd;
      if (hasValidNonNegNumber(rec.costUsd)) {
        costUsd = roundUsd(rec.costUsd);
        cacheSavingsUsd = roundUsd(rec.cacheSavingsUsd || 0);
      } else {
        const rateTs = ts > 0 ? ts : parseDateRateTsMs(dateKey);
        const c = computeTokenCost({
          model,
          inputTokens: input,
          cacheReadTokens: cacheRead,
          outputTokens: output,
          promptTokens: input + cacheRead,
        }, rateTs);
        costUsd = c.costUsd;
        cacheSavingsUsd = c.cacheSavingsUsd;
      }
      next.recordOrder.push(id);
      next.records[id] = {
        dateKey,
        ts,
        model,
        input,
        cacheRead,
        output,
        thinking,
        timedOutput: safeInt(rec.timedOutput),
        streamingSec: safeFloat(rec.streamingSec),
        costUsd,
        cacheSavingsUsd,
      };
    }
  }

  if (parsed.days && typeof parsed.days === 'object' && !Array.isArray(parsed.days)) {
    for (const [dateKey, entry] of Object.entries(parsed.days)) {
      if (!DATE_KEY_RE.test(dateKey) || !entry || typeof entry !== 'object') continue;
      const byModel = Object.create(null);
      if (entry.byModel && typeof entry.byModel === 'object' && !Array.isArray(entry.byModel)) {
        for (const [mKey, mVal] of Object.entries(entry.byModel)) {
          byModel[String(mKey).slice(0, 128)] = safeInt(mVal);
        }
      }
      let byModelDetail = null;
      if (entry.byModelDetail && typeof entry.byModelDetail === 'object' && !Array.isArray(entry.byModelDetail)) {
        byModelDetail = Object.create(null);
        for (const [mKey, det] of Object.entries(entry.byModelDetail)) {
          if (!det || typeof det !== 'object') continue;
          const safeKey = String(mKey).slice(0, 128);
          const dThink = safeInt(det.thinking);
          byModelDetail[safeKey] = {
            total: safeInt(det.total),
            input: safeInt(det.input),
            cacheRead: safeInt(det.cacheRead),
            output: Math.max(safeInt(det.output), dThink),
            thinking: dThink,
            requests: safeInt(det.requests),
            costUsd: hasValidNonNegNumber(det.costUsd) ? roundUsd(det.costUsd) : undefined,
            cacheSavingsUsd: hasValidNonNegNumber(det.cacheSavingsUsd) ? roundUsd(det.cacheSavingsUsd) : 0,
          };
        }
      }
      next.days[dateKey] = {
        total: safeInt(entry.total),
        input: safeInt(entry.input),
        cacheRead: safeInt(entry.cacheRead),
        output: safeInt(entry.output),
        requests: safeInt(entry.requests),
        costUsd: hasValidNonNegNumber(entry.costUsd) ? roundUsd(entry.costUsd) : 0,
        cacheSavingsUsd: hasValidNonNegNumber(entry.cacheSavingsUsd) ? roundUsd(entry.cacheSavingsUsd) : 0,
        unattributedTokens: safeInt(entry.unattributedTokens),
        unattributedCostUsd: hasValidNonNegNumber(entry.unattributedCostUsd) ? roundUsd(entry.unattributedCostUsd) : 0,
        unattributedSavingsUsd: hasValidNonNegNumber(entry.unattributedSavingsUsd) ? roundUsd(entry.unattributedSavingsUsd) : 0,
        byModel,
        byModelDetail,
      };
    }
  }

  reconcileStateCosts(next, { preservePersistedModelCosts: allModelsHaveCost });
  return next;
}

export class UsageLedger {
  /**
   * @param {string | null} filePath
   * @param {{ readOnly?: boolean }} [options]
   */
  constructor(filePath, { readOnly = false } = {}) {
    this.filePath = filePath;
    this.readOnly = readOnly;
    this.state = createEmptyState();
    this.corrupted = false;
    this.lastWriteError = null;
    this._loadPromise = null;
    this._revision = 0;
    this._committedRevision = 0;
    this._flushPromise = null;
  }

  async load() {
    if (!this._loadPromise) {
      this._loadPromise = (async () => {
        if (!this.filePath) return;
        try {
          const raw = await readFile(this.filePath, 'utf8');
          const rebuilt = rebuildSafeState(JSON.parse(raw.replace(/^\uFEFF/, '')));
          if (rebuilt) {
            this.state = rebuilt;
          } else {
            // 发现无法识别或损坏文件时保留磁盘原件，禁止静默覆写覆盖用户历史
            this.corrupted = true;
          }
        } catch (err) {
          if (err?.code !== 'ENOENT') {
            this.corrupted = true;
          }
        }
        if (!this.readOnly && !this.corrupted && this.filePath) {
          await this._consumePendingImport();
        }
      })();
    }
    return this._loadPromise;
  }

  /**
   * 校验并应用离线生成的聚合历史导入包（幂等防重，支持自动处理导入前重叠试运行账本）。
   * @param {any} bundle
   * @param {{ skipFlush?: boolean }} [options]
   */
  async applyImportBundle(bundle, { skipFlush = false } = {}) {
    if (!skipFlush) await this.load();
    if (this.readOnly) return { applied: false, reason: 'readonly' };
    if (this.corrupted) return { applied: false, reason: 'corrupted_ledger' };
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || bundle.schema !== 1) {
      return { applied: false, reason: 'invalid_bundle' };
    }
    const batchId = typeof bundle.batchId === 'string' ? bundle.batchId.trim().slice(0, 80) : '';
    if (!batchId) return { applied: false, reason: 'missing_batch_id' };
    if (this.state.appliedImports.includes(batchId)) {
      return { applied: false, reason: 'already_applied' };
    }

    const cutoffIso = typeof bundle.importedUntil === 'string' && Number.isFinite(Date.parse(bundle.importedUntil))
      ? new Date(Date.parse(bundle.importedUntil)).toISOString()
      : null;

    // 首次导入且开启重叠替换时，仅保留晚于截断水位的新增量记录及未来日期桶，防止后续轮询把新数据双记
    const shouldReplaceOverlap =
      bundle.replaceOverlappingBeforeCutoff === true &&
      !this.state.importedUntil &&
      cutoffIso !== null;

    let futureDaysFallback = null;
    let preservedRecords = null;
    if (shouldReplaceOverlap) {
      const cutoffDateKey = toLocalDateKey(cutoffIso);
      preservedRecords = [];
      const coveredFutureDates = new Set();
      for (const id of this.state.recordOrder) {
        const rec = Object.hasOwn(this.state.records, id) ? this.state.records[id] : null;
        if (rec && rec.dateKey > cutoffDateKey) {
          preservedRecords.push([id, rec]);
          coveredFutureDates.add(rec.dateKey);
        }
      }
      futureDaysFallback = Object.create(null);
      for (const [k, entry] of Object.entries(this.state.days)) {
        if (k > cutoffDateKey && !coveredFutureDates.has(k)) {
          futureDaysFallback[k] = entry;
        }
      }
      this.state.lifetimeTotal = 0;
      this.state.lifetimeCostUsd = 0;
      this.state.lifetimeCacheSavingsUsd = 0;
      this.state.recordOrder = [];
      this.state.records = Object.create(null);
      this.state.days = Object.create(null);
      this.state.models = Object.create(null);
    }

    const bundleModels = Object.create(null);
    if (bundle.models && typeof bundle.models === 'object' && !Array.isArray(bundle.models)) {
      for (const [mKey, m] of Object.entries(bundle.models)) {
        if (!m || typeof m !== 'object') continue;
        const safeModel = String(mKey || 'Unknown').slice(0, 128);
        const mThinking = safeInt(m.thinking);
        const mOutput = Math.max(safeInt(m.output), mThinking);
        bundleModels[safeModel] = {
          total: safeInt(m.total),
          input: safeInt(m.input),
          cacheRead: safeInt(m.cacheRead),
          output: mOutput,
          thinking: mThinking,
          requests: safeInt(m.requests),
          timedOutput: safeInt(m.timedOutput),
          streamingSec: safeFloat(m.streamingSec),
        };
      }
    }
    const bundlePriors = buildModelPriors(bundleModels);

    let addedDayTotal = 0;
    const bundleDayAggByModel = Object.create(null);
    let bundleUnattribCost = 0;
    let bundleUnattribSavings = 0;
    const sortedBundleDates = bundle.days && typeof bundle.days === 'object' && !Array.isArray(bundle.days)
      ? Object.keys(bundle.days).sort()
      : [];

    for (const dateKey of sortedBundleDates) {
      const entry = bundle.days[dateKey];
      if (!DATE_KEY_RE.test(dateKey) || !entry || typeof entry !== 'object') continue;
      const total = safeInt(entry.total);
      const input = safeInt(entry.input);
      const cacheRead = safeInt(entry.cacheRead);
      const output = safeInt(entry.output);
      const requests = safeInt(entry.requests);
      if (total <= 0 && requests <= 0) continue;

      const tempDay = {
        total,
        input,
        cacheRead,
        output,
        requests,
        byModel: Object.create(null),
      };
      if (entry.byModel && typeof entry.byModel === 'object' && !Array.isArray(entry.byModel)) {
        for (const [mKey, mVal] of Object.entries(entry.byModel)) {
          const safeModel = String(mKey || 'Unknown').slice(0, 128);
          tempDay.byModel[safeModel] = (tempDay.byModel[safeModel] || 0) + safeInt(mVal);
        }
      }
      hydrateLegacyDayEntry(dateKey, tempDay, bundlePriors, null);

      if (!Object.hasOwn(this.state.days, dateKey)) {
        this.state.days[dateKey] = {
          total: 0,
          input: 0,
          cacheRead: 0,
          output: 0,
          requests: 0,
          costUsd: 0,
          cacheSavingsUsd: 0,
          unattributedTokens: 0,
          unattributedCostUsd: 0,
          unattributedSavingsUsd: 0,
          byModel: Object.create(null),
          byModelDetail: Object.create(null),
        };
      }
      const d = this.state.days[dateKey];
      d.total += total;
      d.input += input;
      d.cacheRead += cacheRead;
      d.output += output;
      d.requests += requests;
      d.costUsd = roundUsd(d.costUsd + tempDay.costUsd);
      d.cacheSavingsUsd = roundUsd(d.cacheSavingsUsd + tempDay.cacheSavingsUsd);
      d.unattributedTokens = safeInt(d.unattributedTokens) + safeInt(tempDay.unattributedTokens);
      d.unattributedCostUsd = roundUsd((d.unattributedCostUsd || 0) + (tempDay.unattributedCostUsd || 0));
      d.unattributedSavingsUsd = roundUsd((d.unattributedSavingsUsd || 0) + (tempDay.unattributedSavingsUsd || 0));
      bundleUnattribCost += tempDay.unattributedCostUsd || 0;
      bundleUnattribSavings += tempDay.unattributedSavingsUsd || 0;

      for (const [mName, mVal] of Object.entries(tempDay.byModel)) {
        d.byModel[mName] = (d.byModel[mName] || 0) + mVal;
      }
      for (const [mName, det] of Object.entries(tempDay.byModelDetail)) {
        if (!Object.hasOwn(d.byModelDetail, mName)) {
          d.byModelDetail[mName] = createEmptyModelDetail();
        }
        const dstDet = d.byModelDetail[mName];
        dstDet.total += det.total;
        dstDet.input += det.input;
        dstDet.cacheRead += det.cacheRead;
        dstDet.output += det.output;
        dstDet.thinking += det.thinking;
        dstDet.requests += det.requests;
        dstDet.costUsd = roundUsd(dstDet.costUsd + det.costUsd);
        dstDet.cacheSavingsUsd = roundUsd(dstDet.cacheSavingsUsd + det.cacheSavingsUsd);

        if (!Object.hasOwn(bundleDayAggByModel, mName)) {
          bundleDayAggByModel[mName] = { total: 0, costUsd: 0, cacheSavingsUsd: 0 };
        }
        bundleDayAggByModel[mName].total += det.total;
        bundleDayAggByModel[mName].costUsd += det.costUsd;
        bundleDayAggByModel[mName].cacheSavingsUsd += det.cacheSavingsUsd;
      }
      addedDayTotal += total;
    }

    const earliestBundleTs = sortedBundleDates.length > 0
      ? parseDateRateTsMs(sortedBundleDates[0])
      : cutoffIso ? Date.parse(cutoffIso) : Date.now();

    let addedModelsCost = 0;
    let addedModelsSavings = 0;
    for (const [safeModel, m] of Object.entries(bundleModels)) {
      if (!Object.hasOwn(this.state.models, safeModel)) {
        this.state.models[safeModel] = createEmptyModelStats();
      }
      const dst = this.state.models[safeModel];
      dst.total += m.total;
      dst.input += m.input;
      dst.cacheRead += m.cacheRead;
      dst.output += m.output;
      dst.thinking += m.thinking;
      dst.requests += m.requests;
      dst.timedOutput += m.timedOutput;
      dst.streamingSec += m.streamingSec;

      const agg = bundleDayAggByModel[safeModel];
      let mCost = agg ? agg.costUsd : 0;
      let mSav = agg ? agg.cacheSavingsUsd : 0;
      const covered = agg ? agg.total : 0;
      if (m.total > covered) {
        const frac = m.total > 0 ? (m.total - covered) / m.total : 0;
        const c = computeTokenCost({
          model: safeModel,
          inputTokens: m.input * frac,
          cacheReadTokens: m.cacheRead * frac,
          outputTokens: m.output * frac,
          requests: m.requests > 0 ? Math.max(1, Math.round(m.requests * frac)) : undefined,
        }, earliestBundleTs);
        mCost += c.costUsd;
        mSav += c.cacheSavingsUsd;
      }
      dst.costUsd = roundUsd(dst.costUsd + mCost);
      dst.cacheSavingsUsd = roundUsd(dst.cacheSavingsUsd + mSav);
      addedModelsCost += mCost;
      addedModelsSavings += mSav;
    }

    // 同步补齐仅出现在 bundle.days.byModel 但未列在 bundle.models 的模型
    for (const [mName, agg] of Object.entries(bundleDayAggByModel)) {
      if (!Object.hasOwn(bundleModels, mName) && agg.total > 0) {
        if (!Object.hasOwn(this.state.models, mName)) {
          this.state.models[mName] = createEmptyModelStats();
        }
        this.state.models[mName].total += agg.total;
        this.state.models[mName].costUsd = roundUsd(this.state.models[mName].costUsd + agg.costUsd);
        this.state.models[mName].cacheSavingsUsd = roundUsd(this.state.models[mName].cacheSavingsUsd + agg.cacheSavingsUsd);
        addedModelsCost += agg.costUsd;
        addedModelsSavings += agg.cacheSavingsUsd;
      }
    }

    const bundleLifetime = safeInt(bundle.lifetimeTotal);
    this.state.lifetimeTotal += Math.max(bundleLifetime, addedDayTotal);
    this.state.lifetimeCostUsd = roundUsd(this.state.lifetimeCostUsd + addedModelsCost + bundleUnattribCost);
    this.state.lifetimeCacheSavingsUsd = roundUsd(this.state.lifetimeCacheSavingsUsd + addedModelsSavings + bundleUnattribSavings);

    // 还原严格晚于截断水位的增量记录（保留原始 ID 与完整字段，防后续轮询双记）
    if (preservedRecords && preservedRecords.length > 0) {
      for (const [id, rec] of preservedRecords) {
        this.state.records[id] = rec;
        this.state.recordOrder.push(id);
        this._applyDelta(rec.dateKey, rec.model, {
          input: rec.input,
          cacheRead: rec.cacheRead,
          output: rec.output,
          thinking: rec.thinking,
          timedOutput: rec.timedOutput,
          streamingSec: rec.streamingSec,
          costUsd: rec.costUsd,
          cacheSavingsUsd: rec.cacheSavingsUsd,
        }, true);
      }
    }
    if (futureDaysFallback) {
      for (const [dateKey, entry] of Object.entries(futureDaysFallback)) {
        if (!Object.hasOwn(this.state.days, dateKey)) {
          this.state.days[dateKey] = entry;
          this.state.lifetimeTotal += safeInt(entry.total);
          this.state.lifetimeCostUsd = roundUsd(this.state.lifetimeCostUsd + roundUsd(entry.costUsd));
          this.state.lifetimeCacheSavingsUsd = roundUsd(this.state.lifetimeCacheSavingsUsd + roundUsd(entry.cacheSavingsUsd));
          for (const [mKey, det] of Object.entries(entry.byModelDetail || {})) {
            const safeModel = String(mKey || 'Unknown').slice(0, 128);
            if (!Object.hasOwn(this.state.models, safeModel)) {
              this.state.models[safeModel] = createEmptyModelStats();
            }
            const dstM = this.state.models[safeModel];
            dstM.total += safeInt(det.total);
            dstM.input += safeInt(det.input);
            dstM.cacheRead += safeInt(det.cacheRead);
            dstM.output += safeInt(det.output);
            dstM.thinking += safeInt(det.thinking);
            dstM.requests += safeInt(det.requests);
            dstM.costUsd = roundUsd(dstM.costUsd + roundUsd(det.costUsd));
            dstM.cacheSavingsUsd = roundUsd(dstM.cacheSavingsUsd + roundUsd(det.cacheSavingsUsd));
          }
        }
      }
    }

    if (cutoffIso) {
      const prevMs = this.state.importedUntil ? Date.parse(this.state.importedUntil) : 0;
      const nextMs = Date.parse(cutoffIso);
      if (nextMs > prevMs) this.state.importedUntil = cutoffIso;
    }

    this.state.appliedImports.push(batchId);
    if (this.state.appliedImports.length > MAX_APPLIED_IMPORTS) {
      this.state.appliedImports = this.state.appliedImports.slice(-MAX_APPLIED_IMPORTS);
    }

    const dayKeys = Object.keys(this.state.days).sort();
    if (dayKeys.length > MAX_DAYS) {
      for (const k of dayKeys.slice(0, dayKeys.length - MAX_DAYS)) {
        delete this.state.days[k];
      }
    }

    this.state.updatedAt = new Date().toISOString();
    this._revision++;
    if (!skipFlush) {
      await this.flush();
    }
    return { applied: true, batchId, replacedOverlap: shouldReplaceOverlap };
  }

  /**
   * 启动加载时自动吸纳同目录的 pending-import.json，确保即使在宿主运行期间执行导入脚本也不会被旧内存覆写。
   */
  async _consumePendingImport() {
    const pendingPath = join(dirname(this.filePath), 'pending-import.json');
    let raw;
    try {
      raw = await readFile(pendingPath, 'utf8');
    } catch {
      return;
    }
    try {
      const bundle = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const res = await this.applyImportBundle(bundle, { skipFlush: true });
      if (res.applied) {
        await this._flushUnlocked();
      }
      if (res.applied || res.reason === 'already_applied') {
        const appliedPath = join(dirname(this.filePath), 'pending-import.applied.json');
        try {
          await rename(pendingPath, appliedPath);
        } catch {
          try { await unlink(pendingPath); } catch {}
        }
      }
    } catch {
      // 待导入包异常时静默忽略，不影响主账本启动
    }
  }

  _applyDelta(dateKey, model, delta, isNewRequest) {
    if (!Object.hasOwn(this.state.days, dateKey)) {
      this.state.days[dateKey] = {
        total: 0,
        input: 0,
        cacheRead: 0,
        output: 0,
        requests: 0,
        costUsd: 0,
        cacheSavingsUsd: 0,
        unattributedTokens: 0,
        unattributedCostUsd: 0,
        unattributedSavingsUsd: 0,
        byModel: Object.create(null),
        byModelDetail: Object.create(null),
      };
    }
    const d = this.state.days[dateKey];
    if (!d.byModelDetail || typeof d.byModelDetail !== 'object') {
      d.byModelDetail = Object.create(null);
    }
    const deltaTotal = delta.input + delta.cacheRead + delta.output;
    const dCost = roundUsd(delta.costUsd);
    const dSav = roundUsd(delta.cacheSavingsUsd);

    d.total = Math.max(0, d.total + deltaTotal);
    d.input = Math.max(0, d.input + delta.input);
    d.cacheRead = Math.max(0, d.cacheRead + delta.cacheRead);
    d.output = Math.max(0, d.output + delta.output);
    if (isNewRequest) d.requests += 1;
    d.costUsd = roundUsd((d.costUsd || 0) + dCost);
    d.cacheSavingsUsd = roundUsd((d.cacheSavingsUsd || 0) + dSav);
    d.byModel[model] = Math.max(0, (d.byModel[model] || 0) + deltaTotal);

    if (!Object.hasOwn(d.byModelDetail, model)) {
      d.byModelDetail[model] = createEmptyModelDetail();
    }
    const det = d.byModelDetail[model];
    det.total = Math.max(0, det.total + deltaTotal);
    det.input = Math.max(0, det.input + delta.input);
    det.cacheRead = Math.max(0, det.cacheRead + delta.cacheRead);
    det.output = Math.max(0, det.output + delta.output);
    det.thinking = Math.max(0, det.thinking + delta.thinking);
    if (isNewRequest) det.requests += 1;
    det.costUsd = roundUsd((det.costUsd || 0) + dCost);
    det.cacheSavingsUsd = roundUsd((det.cacheSavingsUsd || 0) + dSav);

    if (!Object.hasOwn(this.state.models, model)) {
      this.state.models[model] = createEmptyModelStats();
    }
    const m = this.state.models[model];
    m.total = Math.max(0, m.total + deltaTotal);
    m.input = Math.max(0, m.input + delta.input);
    m.cacheRead = Math.max(0, m.cacheRead + delta.cacheRead);
    m.output = Math.max(0, m.output + delta.output);
    m.thinking = Math.max(0, m.thinking + delta.thinking);
    if (isNewRequest) m.requests += 1;
    m.timedOutput = Math.max(0, m.timedOutput + delta.timedOutput);
    m.streamingSec = Math.max(0, m.streamingSec + delta.streamingSec);
    m.costUsd = roundUsd((m.costUsd || 0) + dCost);
    m.cacheSavingsUsd = roundUsd((m.cacheSavingsUsd || 0) + dSav);

    this.state.lifetimeTotal = Math.max(0, this.state.lifetimeTotal + deltaTotal);
    this.state.lifetimeCostUsd = roundUsd((this.state.lifetimeCostUsd || 0) + dCost);
    this.state.lifetimeCacheSavingsUsd = roundUsd((this.state.lifetimeCacheSavingsUsd || 0) + dSav);
  }

  /**
   * 写入或差值更新一批请求事件。
   */
  async ingest(events) {
    await this.load();
    if (!Array.isArray(events) || events.length === 0) return 0;

    let changed = 0;
    const evictedUntilMs = this.state.evictedUntil ? Date.parse(this.state.evictedUntil) : 0;
    for (const ev of events) {
      if (!ev || typeof ev.id !== 'string' || !ev.id) continue;
      const input = safeInt(ev.inputTokens) + safeInt(ev.cacheWriteTokens);
      const cacheRead = safeInt(ev.cacheReadTokens);
      const thinking = safeInt(ev.thinkingTokens);
      const rawOut = safeInt(ev.outputTokens);
      const respOut = ev.responseOutputTokens !== undefined && ev.responseOutputTokens !== null
        ? safeInt(ev.responseOutputTokens)
        : null;
      // 确保 output 已包含 thinking 且绝不双倍计算：若给了独立 responseOutputTokens 则对齐和值，否则取 Math.max(rawOut, thinking)
      const output = respOut !== null && thinking > 0
        ? Math.max(rawOut, respOut + thinking)
        : Math.max(rawOut, thinking);
      const timedOutput = safeInt(ev.timedOutputTokens);
      const streamingSec = safeFloat(ev.streamingSeconds);
      if (input + cacheRead + output <= 0) continue;

      const id = ev.id.slice(0, 64);
      const model = String(ev.model || 'Unknown').slice(0, 128);
      const prev = Object.hasOwn(this.state.records, id) ? this.state.records[id] : null;

      if (!prev) {
        const parsedTs = typeof ev.timestamp === 'number'
          ? (Number.isFinite(ev.timestamp) ? ev.timestamp : NaN)
          : Date.parse(ev.timestamp || '');
        const evTs = Number.isFinite(parsedTs) && parsedTs > 0 ? Math.round(parsedTs) : Date.now();
        // 已被 MAX_RECORDS FIFO 淘汰的老请求不得因重启回填或翻阅旧会话而重复入账
        if (Number.isFinite(evictedUntilMs) && evictedUntilMs > 0 && Number.isFinite(parsedTs) && parsedTs <= evictedUntilMs) {
          continue;
        }
        const dateKey = toLocalDateKey(evTs);
        const stepCost = computeTokenCost({
          model,
          inputTokens: input,
          cacheReadTokens: cacheRead,
          outputTokens: output,
          promptTokens: input + cacheRead,
        }, evTs);
        this.state.records[id] = {
          dateKey,
          ts: evTs,
          model,
          input,
          cacheRead,
          output,
          thinking,
          timedOutput,
          streamingSec,
          costUsd: stepCost.costUsd,
          cacheSavingsUsd: stepCost.cacheSavingsUsd,
        };
        this.state.recordOrder.push(id);
        this._applyDelta(dateKey, model, {
          input,
          cacheRead,
          output,
          thinking,
          timedOutput,
          streamingSec,
          costUsd: stepCost.costUsd,
          cacheSavingsUsd: stepCost.cacheSavingsUsd,
        }, true);
        changed++;
      } else {
        // 仅当新快照带来增长或补充了流式时长时按差值更新，防止乱序回退；
        // 费用按更新后的完整单步总量重算再取差值，确保跨越 >200k 长上下文阈值时精确跃迁且零舍入漂移
        const nextIn = Math.max(prev.input, input);
        const nextCr = Math.max(prev.cacheRead, cacheRead);
        const nextOut = Math.max(prev.output, output);
        const nextTh = Math.max(prev.thinking, thinking);
        const dIn = nextIn - prev.input;
        const dCr = nextCr - prev.cacheRead;
        const dOut = nextOut - prev.output;
        const dTh = nextTh - prev.thinking;
        const dTimed = timedOutput > prev.timedOutput ? timedOutput - prev.timedOutput : 0;
        const dSec = streamingSec > prev.streamingSec ? streamingSec - prev.streamingSec : 0;
        if (dIn + dCr + dOut + dTh + dTimed > 0 || dSec > 0) {
          const recTs = prev.ts > 0 ? prev.ts : parseDateRateTsMs(prev.dateKey);
          const fullNextCost = computeTokenCost({
            model: prev.model,
            inputTokens: nextIn,
            cacheReadTokens: nextCr,
            outputTokens: nextOut,
            promptTokens: nextIn + nextCr,
          }, recTs);
          const dCost = roundUsd(Math.max(0, fullNextCost.costUsd - roundUsd(prev.costUsd || 0)));
          const dSavings = roundUsd(Math.max(0, fullNextCost.cacheSavingsUsd - roundUsd(prev.cacheSavingsUsd || 0)));

          prev.input = nextIn;
          prev.cacheRead = nextCr;
          prev.output = nextOut;
          prev.thinking = nextTh;
          prev.timedOutput += dTimed;
          prev.streamingSec += dSec;
          prev.costUsd = roundUsd(roundUsd(prev.costUsd || 0) + dCost);
          prev.cacheSavingsUsd = roundUsd(roundUsd(prev.cacheSavingsUsd || 0) + dSavings);

          this._applyDelta(prev.dateKey, prev.model, {
            input: dIn,
            cacheRead: dCr,
            output: dOut,
            thinking: dTh,
            timedOutput: dTimed,
            streamingSec: dSec,
            costUsd: dCost,
            cacheSavingsUsd: dSavings,
          }, false);
          changed++;
        }
      }
    }

    if (changed > 0) {
      if (this.state.recordOrder.length > MAX_RECORDS) {
        const overflow = this.state.recordOrder.splice(0, this.state.recordOrder.length - MAX_RECORDS);
        let maxEvictedMs = this.state.evictedUntil ? Date.parse(this.state.evictedUntil) : 0;
        if (!Number.isFinite(maxEvictedMs)) maxEvictedMs = 0;
        for (const oldId of overflow) {
          const oldRec = Object.hasOwn(this.state.records, oldId) ? this.state.records[oldId] : null;
          if (oldRec) {
            const recMs = safeInt(oldRec.ts) || parseLocalMidnightMs(oldRec.dateKey);
            if (Number.isFinite(recMs) && recMs > maxEvictedMs) maxEvictedMs = recMs;
          }
          delete this.state.records[oldId];
        }
        if (maxEvictedMs > 0) {
          this.state.evictedUntil = new Date(maxEvictedMs).toISOString();
        }
      }
      const dayKeys = Object.keys(this.state.days).sort();
      if (dayKeys.length > MAX_DAYS) {
        for (const k of dayKeys.slice(0, dayKeys.length - MAX_DAYS)) {
          delete this.state.days[k];
        }
      }
      this.state.updatedAt = new Date().toISOString();
      this._revision++;
      await this.flush();
    }
    return changed;
  }

  async getImportedUntilMs() {
    await this.load();
    if (!this.state.importedUntil) return 0;
    const ms = Date.parse(this.state.importedUntil);
    return Number.isFinite(ms) ? ms : 0;
  }

  async getEvictedUntilMs() {
    await this.load();
    if (!this.state.evictedUntil) return 0;
    const ms = Date.parse(this.state.evictedUntil);
    return Number.isFinite(ms) ? ms : 0;
  }

  /**
   * 写入历史迁移水位线并安全落盘（供一次性历史账本导入工具调用，防后台回填重复记账）。
   */
  async setImportedUntil(isoString) {
    await this.load();
    if (typeof isoString !== 'string' || !Number.isFinite(Date.parse(isoString))) return;
    const prevMs = this.state.importedUntil ? Date.parse(this.state.importedUntil) : 0;
    const nextMs = Date.parse(isoString);
    if (nextMs > prevMs) {
      this.state.importedUntil = new Date(nextMs).toISOString();
      this.state.updatedAt = new Date().toISOString();
      this._revision++;
      await this.flush();
    }
  }

  /**
   * 基于版本号的循环原子刷盘：保证在途写完后若期间又有新写入会自动续刷，绝不丢账。
   */
  async flush() {
    await this.load();
    return this._flushUnlocked();
  }

  async _flushUnlocked() {
    if (this.readOnly || this.corrupted || !this.filePath) return;
    while (this._flushPromise) {
      try {
        await this._flushPromise;
      } catch {
        // 等待前一个落盘结束，后续重新评估版本号
      }
      if (this._committedRevision >= this._revision) return;
    }

    const current = (async () => {
      while (this._committedRevision < this._revision) {
        const targetRev = this._revision;
        const payload = JSON.stringify(this.state);
        const tmp = `${this.filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
        try {
          await mkdir(dirname(this.filePath), { recursive: true });
          await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
          await renameWithRetry(tmp, this.filePath);
          this._committedRevision = targetRev;
          this.lastWriteError = null;
        } catch (err) {
          this.lastWriteError = err?.code || 'write_failed';
          try { await unlink(tmp); } catch {}
          throw err;
        }
      }
    })();

    this._flushPromise = current;
    try {
      await current;
    } finally {
      if (this._flushPromise === current) {
        this._flushPromise = null;
      }
    }
  }

  async snapshot(now = new Date()) {
    await this.load();
    const validNow = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
    const todayKey = toLocalDateKey(validNow);
    const monthPrefix = todayKey.slice(0, 7);
    const [ty, tm, td] = todayKey.split('-').map(Number);
    // 锚定本地正午 12:00 推算日历日序列，免疫夏令时（DST）跨午夜 1 小时回拨/跳变
    const todayNoon = new Date(ty, tm - 1, td, 12, 0, 0, 0);

    const weekKeys = new Set();
    for (let i = 0; i < 7; i++) {
      const d = new Date(todayNoon);
      d.setDate(d.getDate() - i);
      weekKeys.add(toLocalDateKey(d));
    }

    let todayTokens = 0;
    let todayInput = 0;
    let todayCacheRead = 0;
    let todayOutput = 0;
    let todayRequests = 0;
    let todayByModel = [];
    let weekTokens = 0;
    let monthTokens = 0;
    let monthInput = 0;
    let monthCacheRead = 0;
    let monthOutput = 0;
    let monthRequests = 0;
    let totalRequests = 0;
    let peakDay = null;
    let todayCostUsd = 0;
    let todayCacheSavingsUsd = 0;
    let weekCostUsd = 0;
    let weekCacheSavingsUsd = 0;
    let monthCostUsd = 0;
    let monthCacheSavingsUsd = 0;
    const daysList = [];

    const sortedKeys = Object.keys(this.state.days).sort();

    for (let idx = 0; idx < sortedKeys.length; idx++) {
      const key = sortedKeys[idx];
      const entry = this.state.days[key];
      const t = safeInt(entry?.total);
      const reqs = safeInt(entry?.requests);
      const dayCostUsd = roundUsd(entry?.costUsd || 0);
      const daySavingsUsd = roundUsd(entry?.cacheSavingsUsd || 0);

      totalRequests += reqs;
      if (t > 0 && (!peakDay || t > peakDay.total)) {
        peakDay = { date: key, total: t, costUsd: dayCostUsd };
      }

      const bm = {};
      const bmc = {};
      if (entry?.byModel && typeof entry.byModel === 'object') {
        for (const [mKey, mVal] of Object.entries(entry.byModel)) {
          const v = safeInt(mVal);
          if (v > 0) bm[String(mKey)] = v;
        }
      }
      if (entry?.byModelDetail && typeof entry.byModelDetail === 'object') {
        for (const [mKey, det] of Object.entries(entry.byModelDetail)) {
          const v = safeInt(det?.total);
          if (v > 0) {
            const name = String(mKey);
            if (!Object.hasOwn(bm, name)) bm[name] = v;
            bmc[name] = roundUsd(det.costUsd || 0);
          }
        }
      }

      if (key === todayKey) {
        todayTokens = t;
        todayInput = safeInt(entry?.input);
        todayCacheRead = safeInt(entry?.cacheRead);
        todayOutput = safeInt(entry?.output);
        todayRequests = reqs;
        todayCostUsd = dayCostUsd;
        todayCacheSavingsUsd = daySavingsUsd;
        if (entry?.byModelDetail && typeof entry.byModelDetail === 'object') {
          todayByModel = Object.entries(entry.byModelDetail)
            .map(([model, det]) => ({
              model: String(model),
              totalTokens: safeInt(det?.total),
              inputTokens: safeInt(det?.input),
              cacheReadTokens: safeInt(det?.cacheRead),
              outputTokens: safeInt(det?.output),
              requests: safeInt(det?.requests),
              costUsd: roundUsd(det?.costUsd || 0),
              cacheSavingsUsd: roundUsd(det?.cacheSavingsUsd || 0),
            }))
            .filter((x) => x.totalTokens > 0)
            .sort((a, b) => b.totalTokens - a.totalTokens);
        } else {
          todayByModel = Object.entries(bm)
            .map(([model, totalTokens]) => ({
              model: String(model),
              totalTokens: safeInt(totalTokens),
              costUsd: roundUsd(bmc[model] || 0),
            }))
            .filter((x) => x.totalTokens > 0)
            .sort((a, b) => b.totalTokens - a.totalTokens);
        }
      }

      if (weekKeys.has(key)) {
        weekTokens += t;
        weekCostUsd += dayCostUsd;
        weekCacheSavingsUsd += daySavingsUsd;
      }
      if (key.startsWith(monthPrefix)) {
        monthTokens += t;
        monthInput += safeInt(entry?.input);
        monthCacheRead += safeInt(entry?.cacheRead);
        monthOutput += safeInt(entry?.output);
        monthRequests += reqs;
        monthCostUsd += dayCostUsd;
        monthCacheSavingsUsd += daySavingsUsd;
      }

      daysList.push({
        date: key,
        total: t,
        input: safeInt(entry?.input),
        cacheRead: safeInt(entry?.cacheRead),
        output: safeInt(entry?.output),
        requests: reqs,
        costUsd: dayCostUsd,
        cacheSavingsUsd: daySavingsUsd,
        byModel: bm,
        byModelCost: bmc,
      });
    }

    // 计算当前连续活跃天数与历史最长连续活跃天数
    const activeDateSet = new Set(daysList.filter((d) => d.total > 0).map((d) => d.date));
    let currentStreak = 0;
    const cursor = new Date(todayNoon);
    if (!activeDateSet.has(toLocalDateKey(cursor))) {
      cursor.setDate(cursor.getDate() - 1);
    }
    while (activeDateSet.has(toLocalDateKey(cursor))) {
      currentStreak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    let longestStreak = 0;
    let runStreak = 0;
    let prevDayMs = null;
    for (const key of [...activeDateSet].sort()) {
      const [y, m, d] = key.split('-').map(Number);
      const utcMs = Date.UTC(y, m - 1, d);
      if (prevDayMs !== null && utcMs - prevDayMs === 86400000) {
        runStreak++;
      } else {
        runStreak = 1;
      }
      if (runStreak > longestStreak) longestStreak = runStreak;
      prevDayMs = utcMs;
    }

    const nowMs = validNow.getTime();
    const modelRank = Object.entries(this.state.models)
      .filter(([, m]) => safeInt(m?.total) > 0)
      .map(([name, m]) => {
        const pricing = getModelPricing(name, nowMs);
        return {
          model: String(name),
          totalTokens: safeInt(m.total),
          inputTokens: safeInt(m.input),
          outputTokens: safeInt(m.output),
          thinkingTokens: safeInt(m.thinking),
          cacheReadTokens: safeInt(m.cacheRead),
          requests: safeInt(m.requests),
          avgTps: m.streamingSec > 0 ? Number((m.timedOutput / m.streamingSec).toFixed(1)) : null,
          costUsd: roundUsd(m.costUsd),
          cacheSavingsUsd: roundUsd(m.cacheSavingsUsd),
          pricing,
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 60);

    return {
      todayDate: todayKey,
      monthKey: monthPrefix,
      todayTokens,
      todayCostUsd: roundUsd(todayCostUsd),
      todayCacheSavingsUsd: roundUsd(todayCacheSavingsUsd),
      todayInput,
      todayCacheRead,
      todayOutput,
      todayRequests,
      todayByModel,
      weekTokens,
      weekCostUsd: roundUsd(weekCostUsd),
      weekCacheSavingsUsd: roundUsd(weekCacheSavingsUsd),
      monthTokens,
      monthCostUsd: roundUsd(monthCostUsd),
      monthCacheSavingsUsd: roundUsd(monthCacheSavingsUsd),
      monthInput,
      monthCacheRead,
      monthOutput,
      monthRequests,
      totalRequests,
      peakDay,
      currentStreak,
      longestStreak,
      activeDays: activeDateSet.size,
      totalTokens: safeInt(this.state.lifetimeTotal),
      totalCostUsd: roundUsd(this.state.lifetimeCostUsd),
      lifetimeCacheSavingsUsd: roundUsd(this.state.lifetimeCacheSavingsUsd),
      importedUntil: this.state.importedUntil,
      days: daysList.slice(-365),
      modelRank,
      corrupted: this.corrupted,
      updatedAt: this.state.updatedAt,
    };
  }
}
