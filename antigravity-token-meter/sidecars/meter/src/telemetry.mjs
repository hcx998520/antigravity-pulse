/**
 * Token 速率、缓存命中率、上下文窗口与模型额度计算引擎（严格输入校验版）。
 *
 * 数据边界：
 * - 内存读取：仅读取宿主 RPC 返回的数值统计、模型名称与配额比例；
 * - 绝不读取、缓存或向外透传任何 systemPrompt、对话正文、用户邮箱或令牌；
 * - 账本去重键采用局部 SHA-256 不可逆哈希，不落盘原始会话 ID 或消息 ID。
 */
import { createHash } from 'node:crypto';
import { computeTokenCost } from './pricing.mjs';

const MAX_METADATA_ITEMS = 5000;
const INT_STR_RE = /^\d{1,15}$/;
const DUR_STR_RE = /^(\d{1,9}(?:\.\d{1,9})?)s$/i;

/**
 * 严格解析 Protobuf Duration（字符串 "6.25s" 或 { seconds, nanos } 对象）。
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseDurationSeconds(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= 86400 ? value : null;
  }
  if (typeof value === 'string') {
    const m = value.trim().match(DUR_STR_RE);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n >= 0 && n <= 86400 ? n : null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sec = value.seconds === undefined ? 0 : Number(value.seconds);
    const nanos = value.nanos === undefined ? 0 : Number(value.nanos);
    if (
      Number.isInteger(sec) && sec >= 0 && sec <= 86400 &&
      Number.isInteger(nanos) && nanos >= 0 && nanos < 1e9
    ) {
      return sec + nanos / 1e9;
    }
  }
  return null;
}

/**
 * 严格解析非负安全整数 Token 计数（拒绝布尔、数组、空白文本、Infinity）。
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseTokenCount(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!INT_STR_RE.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

/**
 * 根据重置时间推导配额周期类型（仅用于展示标签：5 小时滚动窗口或周窗口）。
 * @param {string | null} resetTime
 * @param {number} [nowMs]
 * @returns {'5h' | 'week' | null}
 */
export function inferQuotaWindowKind(resetTime, nowMs = Date.now()) {
  if (!resetTime || typeof resetTime !== 'string') return null;
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts)) return null;
  const deltaMs = ts - nowMs;
  if (deltaMs <= 0) return null;
  // 5 小时滚动窗口（宽容 30 分钟时钟偏差）
  if (deltaMs <= 5.5 * 3600 * 1000) return '5h';
  // 周限额窗口（5.5 小时以上至 8 天内）
  if (deltaMs <= 8 * 86400 * 1000) return 'week';
  return null;
}

/**
 * 综合桶元数据标签与重置时间，判断单个配额桶属于 5h 窗口还是周窗口。
 * @param {any} bucket
 * @param {number} [nowMs]
 * @returns {'5h' | 'week' | null}
 */
export function classifyQuotaBucket(bucket, nowMs = Date.now()) {
  if (!bucket || typeof bucket !== 'object') return null;
  const hint = [
    bucket.window,
    bucket.refreshWindowLabel,
    bucket.displayName,
    bucket.bucketId,
    bucket.description,
  ]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ')
    .toLowerCase();

  if (/(?:^|[^a-z0-9])(5\s*h|5[\s_-]*hour|five[\s_-]*hour)|5\s*小时/.test(hint)) {
    return '5h';
  }
  if (/(?:^|[^a-z0-9])(week|weekly|7\s*d|7[\s_-]*day)|每周|周额度|周限额/.test(hint)) {
    return 'week';
  }
  return inferQuotaWindowKind(bucket.resetTime, nowMs);
}

/**
 * 计算配额消耗节奏：对比当前剩余额度与窗口剩余时间比例，产出刻度线位置与节奏状态。
 * @param {number} remainingFraction
 * @param {string | null} resetTime
 * @param {'5h' | 'week' | null} windowKind
 * @param {number} [nowMs]
 */
export function computeQuotaPacing(remainingFraction, resetTime, windowKind, nowMs = Date.now()) {
  if (typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction)) return null;
  if (windowKind !== '5h' && windowKind !== 'week') return null;
  if (!resetTime || typeof resetTime !== 'string') return null;
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts)) return null;
  const deltaMs = ts - nowMs;
  if (deltaMs <= 0) return null;

  const windowMs = windowKind === '5h' ? 5 * 3600 * 1000 : 7 * 86400 * 1000;
  const timeRemainingFraction = Math.max(0, Math.min(1, deltaMs / windowMs));
  const rem = Math.max(0, Math.min(1, remainingFraction));
  const delta = rem - timeRemainingFraction;
  const status = delta >= -0.08 ? 'ok' : delta >= -0.22 ? 'fast' : 'burn';
  return {
    timeRemainingFraction: Number(timeRemainingFraction.toFixed(4)),
    delta: Number(delta.toFixed(4)),
    status,
  };
}

function normalizeBucketEntry(bucket, nowMs) {
  if (!bucket || typeof bucket !== 'object' || bucket.disabled === true) return null;
  if (typeof bucket.remainingFraction !== 'number' || !Number.isFinite(bucket.remainingFraction)) return null;
  const frac = Math.max(0, Math.min(1, bucket.remainingFraction));
  const resetTime = typeof bucket.resetTime === 'string' && Number.isFinite(Date.parse(bucket.resetTime)) ? bucket.resetTime : null;
  const kind = classifyQuotaBucket(bucket, nowMs);
  return {
    remainingFraction: frac,
    resetTime,
    windowKind: kind,
    pacing: computeQuotaPacing(frac, resetTime, kind, nowMs),
    label: typeof bucket.displayName === 'string' ? bucket.displayName.trim().slice(0, 120) : '',
  };
}

/**
 * 解析 RetrieveUserQuotaSummaryResponse 响应为脱敏分组列表（含 5h 与周额度双轨）。
 * @param {any} rawSummary
 * @param {number} [nowMs]
 */
export function projectQuotaSummary(rawSummary, nowMs = Date.now()) {
  const body = rawSummary?.response && typeof rawSummary.response === 'object' ? rawSummary.response : rawSummary;
  if (!body || typeof body !== 'object') return [];

  const groupsInput = Array.isArray(body.groups) ? body.groups.slice(0, 50) : [];
  const projected = [];

  for (const grp of groupsInput) {
    if (!grp || typeof grp !== 'object') continue;
    const rawBuckets = Array.isArray(grp.buckets) ? grp.buckets.slice(0, 20) : [];
    const entries = rawBuckets.map((b) => normalizeBucketEntry(b, nowMs)).filter(Boolean);
    if (entries.length === 0) continue;

    let fiveHour = null;
    let weekly = null;
    for (const e of entries) {
      if (e.windowKind === '5h') {
        if (!fiveHour || e.remainingFraction < fiveHour.remainingFraction) {
          fiveHour = { remainingFraction: e.remainingFraction, resetTime: e.resetTime, pacing: e.pacing };
        }
      } else if (e.windowKind === 'week') {
        if (!weekly || e.remainingFraction < weekly.remainingFraction) {
          weekly = { remainingFraction: e.remainingFraction, resetTime: e.resetTime, pacing: e.pacing };
        }
      }
    }

    const title = (typeof grp.displayName === 'string' && grp.displayName.trim().slice(0, 120)) || entries[0].label || 'Quota';
    const leadEntry = entries.reduce((min, cur) => (cur.remainingFraction < min.remainingFraction ? cur : min), entries[0]);
    const modelHints = [title, ...entries.map((e) => e.label).filter(Boolean)].filter((v, idx, arr) => arr.indexOf(v) === idx);
    projected.push({
      title,
      leadModel: title,
      modelCount: 1,
      models: modelHints,
      remainingFraction: leadEntry.remainingFraction,
      resetTime: leadEntry.resetTime,
      windowKind: leadEntry.windowKind,
      pacing: leadEntry.pacing,
      fiveHour,
      weekly,
    });
  }

  // 若顶层 buckets 有数据且 groups 为空，合并成默认分组
  if (projected.length === 0 && Array.isArray(body.buckets) && body.buckets.length > 0) {
    const entries = body.buckets.slice(0, 20).map((b) => normalizeBucketEntry(b, nowMs)).filter(Boolean);
    if (entries.length > 0) {
      let fiveHour = null;
      let weekly = null;
      for (const e of entries) {
        if (e.windowKind === '5h') {
          if (!fiveHour || e.remainingFraction < fiveHour.remainingFraction) {
            fiveHour = { remainingFraction: e.remainingFraction, resetTime: e.resetTime, pacing: e.pacing };
          }
        } else if (e.windowKind === 'week') {
          if (!weekly || e.remainingFraction < weekly.remainingFraction) {
            weekly = { remainingFraction: e.remainingFraction, resetTime: e.resetTime, pacing: e.pacing };
          }
        }
      }
      const leadEntry = entries.reduce((min, cur) => (cur.remainingFraction < min.remainingFraction ? cur : min), entries[0]);
      projected.push({
        title: leadEntry.label || 'Model Quota',
        leadModel: leadEntry.label || 'Model Quota',
        modelCount: 1,
        models: [leadEntry.label || 'Model Quota'],
        remainingFraction: leadEntry.remainingFraction,
        resetTime: leadEntry.resetTime,
        windowKind: leadEntry.windowKind,
        pacing: leadEntry.pacing,
        fiveHour,
        weekly,
      });
    }
  }

  return projected;
}

/**
 * 从模型名提取家族归属，用于在官方分组名为通用家族名（如 "Claude and GPT models" / "Gemini Models"）时精准匹配。
 */
function inferModelFamily(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return null;
  if (/\b(claude|anthropic)\b/.test(s)) return 'claude_gpt';
  if (/\b(gpt|openai|o1|o3|o4|codex)\b/.test(s)) return 'claude_gpt';
  if (/\bgemini\b/.test(s)) return 'gemini';
  return null;
}

/**
 * 为底部状态条挑选「5小时额度 / 周额度」双值摘要（优先匹配当前会话模型所在分组）。
 * @param {Array<any>} quotas
 * @param {string | null} [activeModel]
 */
export function selectQuotaPair(quotas, activeModel = null) {
  if (!Array.isArray(quotas) || quotas.length === 0) return null;

  let chosen = null;
  if (typeof activeModel === 'string' && activeModel.trim()) {
    const needle = activeModel.trim().toLowerCase().replace(/\s*\([^)]*\)$/, '');
    const buildHay = (q) => [q.title, q.leadModel, ...(Array.isArray(q.models) ? q.models : [])]
      .filter((s) => typeof s === 'string')
      .join(' ')
      .toLowerCase();

    // 1. 优先精确子串匹配（双向兼容具体型号与通用组名）
    chosen = quotas.find((q) => {
      const hay = buildHay(q);
      const titleLow = String(q.title || '').trim().toLowerCase();
      return Boolean(needle) && (hay.includes(needle) || (titleLow.length >= 4 && needle.includes(titleLow)));
    }) || null;

    // 2. 回退按模型家族匹配（如 "Claude Opus 5.5" -> "Claude and GPT models"，"Gemini 4 Neon" -> "Gemini Models"）
    if (!chosen) {
      const fam = inferModelFamily(needle);
      if (fam === 'claude_gpt') {
        chosen = quotas.find((q) => /\b(claude|gpt|openai)\b/.test(buildHay(q))) || null;
      } else if (fam === 'gemini') {
        chosen = quotas.find((q) => /\bgemini\b/.test(buildHay(q))) || null;
      }
    }
  }

  // 优先选同时有 5h 与周额度的分组，其次按最紧迫的组回退
  if (!chosen) {
    chosen = quotas.find((q) => q.fiveHour && q.weekly) || quotas[0];
  }

  const fiveHour = chosen.fiveHour || (chosen.windowKind === '5h' ? { remainingFraction: chosen.remainingFraction, resetTime: chosen.resetTime } : null);
  const weekly = chosen.weekly || (chosen.windowKind === 'week' ? { remainingFraction: chosen.remainingFraction, resetTime: chosen.resetTime } : null);

  return {
    title: chosen.title || '',
    fiveHourFraction: fiveHour ? fiveHour.remainingFraction : null,
    fiveHourResetTime: fiveHour ? fiveHour.resetTime : null,
    weeklyFraction: weekly ? weekly.remainingFraction : null,
    weeklyResetTime: weekly ? weekly.resetTime : null,
    fallbackFraction: chosen.remainingFraction,
  };
}

/**
 * 将 GetUserStatus 与可选 RetrieveUserQuotaSummary 立即投影为最小脱敏 DTO（不保留邮箱、头像、账单等原始字段）。
 * @param {any} userStatus
 * @param {number} [nowMs]
 * @param {any} [quotaSummary]
 */
export function projectUserStatus(userStatus, nowMs = Date.now(), quotaSummary = null) {
  const labelMap = new Map();
  const rawQuotas = [];
  const configs = userStatus?.cascadeModelConfigData?.clientModelConfigs;
  if (Array.isArray(configs)) {
    for (const cfg of configs.slice(0, 200)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const id = cfg.modelOrAlias?.model || cfg.modelOrAlias?.alias;
      const label = typeof cfg.label === 'string' ? cfg.label.trim().slice(0, 120) : '';
      if (id && label) labelMap.set(String(id).slice(0, 120), label);

      const q = cfg.quotaInfo;
      if (q && typeof q.remainingFraction === 'number' && Number.isFinite(q.remainingFraction)) {
        const frac = Math.max(0, Math.min(1, q.remainingFraction));
        const resetTime = typeof q.resetTime === 'string' && Number.isFinite(Date.parse(q.resetTime)) ? q.resetTime : null;
        rawQuotas.push({ label: label || 'Model', remainingFraction: frac, resetTime });
      }
    }
  }

  // 若 RetrieveUserQuotaSummary 可用，优先使用官方 5h / 周额度分桶摘要
  const summaryQuotas = projectQuotaSummary(quotaSummary, nowMs);
  if (summaryQuotas.length > 0) {
    return { labelMap, quotas: summaryQuotas };
  }

  // 否则回退到 GetUserStatus 的 clientModelConfigs.quotaInfo 聚合
  const grouped = new Map();
  for (const item of rawQuotas) {
    const key = `${item.resetTime || 'none'}|${Math.round(item.remainingFraction * 1000)}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        remainingFraction: item.remainingFraction,
        resetTime: item.resetTime,
        models: [],
      });
    }
    const g = grouped.get(key);
    if (!g.models.includes(item.label)) g.models.push(item.label);
  }

  const quotas = [...grouped.values()]
    .map((g) => {
      const lead = g.models[0] || 'Model';
      const title = g.models.length > 1 ? `${lead.replace(/\s*\([^)]*\)$/, '')} (+${g.models.length - 1})` : lead;
      const kind = inferQuotaWindowKind(g.resetTime, nowMs);
      const pacing = computeQuotaPacing(g.remainingFraction, g.resetTime, kind, nowMs);
      return {
        title,
        leadModel: lead,
        modelCount: g.models.length,
        models: g.models.slice(0, 12),
        remainingFraction: g.remainingFraction,
        resetTime: g.resetTime,
        windowKind: kind,
        pacing,
        fiveHour: kind === '5h' ? { remainingFraction: g.remainingFraction, resetTime: g.resetTime, pacing } : null,
        weekly: kind === 'week' ? { remainingFraction: g.remainingFraction, resetTime: g.resetTime, pacing } : null,
      };
    })
    .sort((a, b) => a.remainingFraction - b.remainingFraction);

  return { labelMap, quotas };
}

/**
 * 兼容导出：构建 modelId -> 人类可读名称映射。
 */
export function buildModelLabelMap(userStatus) {
  return projectUserStatus(userStatus).labelMap;
}

/**
 * 兼容导出：提取聚合配额列表。
 */
export function extractQuotaGroups(userStatus) {
  return projectUserStatus(userStatus).quotas;
}

export function resolveModelName(rawId, labelMap) {
  if (!rawId || typeof rawId !== 'string') return 'Unknown';
  const key = rawId.trim().slice(0, 120);
  if (!key) return 'Unknown';
  return labelMap?.get(key) || key;
}

/**
 * 过滤极端短窗口缓冲毛刺，防止 10ms 尾包把速率拉爆至数万 tok/s。
 */
export function isReliableSpeedSample(sample) {
  if (!sample.streamingSeconds || sample.streamingSeconds <= 0) return false;
  if (!sample.outputTokens || sample.outputTokens <= 0) return false;
  const rawTps = sample.outputTokens / sample.streamingSeconds;
  if (!Number.isFinite(rawTps) || rawTps <= 0) return false;
  if (sample.streamingSeconds < 0.05 && rawTps > 2500) return false;
  if (
    sample.streamingSeconds < 0.4 &&
    sample.ttftSeconds !== null &&
    sample.ttftSeconds >= 2 &&
    rawTps > 1200
  ) {
    return false;
  }
  return true;
}

function hashEventKey(namespace, rawKey) {
  return createHash('sha256').update(`${namespace}\0${rawKey}`).digest('hex').slice(0, 24);
}

/**
 * 先归一化并按请求键去重，再统一计算会话指标与账本 upsert 事件，保证 UI 与账本 100% 口径一致。
 */
export function computeConversationTelemetry({
  cascadeId,
  status = '',
  generatorMetadata = [],
  modelLabelMap = new Map(),
  fallbackDate = new Date().toISOString(),
}) {
  const list = Array.isArray(generatorMetadata)
    ? generatorMetadata.slice(0, MAX_METADATA_ITEMS)
    : [];

  let latestContext = null;
  const deduped = new Map();

  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const cm = entry?.chatModel;
    if (!cm || typeof cm !== 'object' || Array.isArray(cm)) continue;

    const ctxMeta = cm.chatStartMetadata?.contextWindowMetadata;
    if (ctxMeta && typeof ctxMeta === 'object') {
      const used = parseTokenCount(ctxMeta.estimatedTokensUsed);
      const max = parseTokenCount(ctxMeta.maxContextTokens);
      if (used !== null && max !== null && max > 0) {
        latestContext = {
          usedTokens: used,
          maxTokens: max,
          remainingTokens: Math.max(0, max - used),
          usedFraction: Math.min(1, used / max),
        };
      }
    }

    const usage = cm.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;

    const uncachedInput = parseTokenCount(usage.inputTokens) ?? 0;
    const cacheRead = parseTokenCount(usage.cacheReadTokens) ?? 0;
    const cacheWrite = parseTokenCount(usage.cacheCreationInputTokens ?? usage.cacheWriteTokens) ?? 0;
    const responseOut = parseTokenCount(usage.responseOutputTokens);
    const thinkingOut = parseTokenCount(usage.thinkingOutputTokens);
    const rawOut = parseTokenCount(usage.outputTokens);

    const effectiveOutput =
      rawOut !== null
        ? rawOut
        : responseOut !== null || thinkingOut !== null
          ? (responseOut ?? 0) + (thinkingOut ?? 0)
          : 0;
    const effectiveResponse =
      responseOut !== null
        ? responseOut
        : thinkingOut !== null
          ? Math.max(0, effectiveOutput - thinkingOut)
          : effectiveOutput;
    const effectiveThinking = thinkingOut ?? 0;

    if (uncachedInput + cacheRead + cacheWrite + effectiveOutput <= 0) continue;

    const modelName = resolveModelName(
      cm.modelDisplayName || cm.responseModel || cm.model || usage.model || '',
      modelLabelMap
    );
    const streamingSec = parseDurationSeconds(cm.streamingDuration);
    const ttftSec = parseDurationSeconds(cm.timeToFirstToken);

    const stepTag = Array.isArray(entry.stepIndices) && entry.stepIndices.length > 0
      ? `step:${entry.stepIndices.join(',')}`
      : `idx:${i}`;
    const rawStableId =
      (typeof usage.responseId === 'string' && usage.responseId.trim()) ||
      (typeof usage.messageId === 'string' && usage.messageId.trim()) ||
      stepTag;

    const hashedKey = hashEventKey(String(cascadeId || 'default'), rawStableId);
    const rawTs = [cm.requestTime, cm.startTime, cm.createdAt, cm.chatStartMetadata?.createdAt]
      .find((v) => typeof v === 'string' && Number.isFinite(Date.parse(v)));
    const hasExactTimestamp = Boolean(rawTs);
    const ts = rawTs || fallbackDate;

    // 同一请求后续出现更完整的最终快照时覆盖旧中间态
    deduped.set(hashedKey, {
      id: hashedKey,
      timestamp: ts,
      hasExactTimestamp,
      model: modelName,
      inputTokens: uncachedInput,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      outputTokens: effectiveOutput,
      responseOutputTokens: effectiveResponse,
      thinkingTokens: effectiveThinking,
      streamingSeconds: streamingSec,
      ttftSeconds: ttftSec,
    });
  }

  let totalUncachedInput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalOutput = 0;
  let totalResponseOutput = 0;
  let totalThinkingOutput = 0;
  let weightedOutput = 0;
  let weightedStreamingSec = 0;
  let measuredRequests = 0;
  let excludedOutliers = 0;

  let latestSample = null;
  let latestModel = null;
  let lastRequestMs = 0;
  let lastRequestTime = null;
  const sparkline = [];
  const ledgerEvents = [];

  for (const item of deduped.values()) {
    totalUncachedInput += item.inputTokens;
    totalCacheRead += item.cacheReadTokens;
    totalCacheWrite += item.cacheWriteTokens;
    totalOutput += item.outputTokens;
    totalResponseOutput += item.responseOutputTokens;
    totalThinkingOutput += item.thinkingTokens;
    latestModel = item.model;
    const itemMs = Date.parse(item.timestamp);
    if (Number.isFinite(itemMs) && itemMs >= lastRequestMs) {
      lastRequestMs = itemMs;
      lastRequestTime = item.timestamp;
    }

    let reliableTps = null;
    if (item.streamingSeconds !== null && item.streamingSeconds > 0 && item.outputTokens > 0) {
      if (isReliableSpeedSample(item)) {
        reliableTps = item.outputTokens / item.streamingSeconds;
        weightedOutput += item.outputTokens;
        weightedStreamingSec += item.streamingSeconds;
        measuredRequests++;
        latestSample = {
          tps: Number(reliableTps.toFixed(1)),
          ttft: item.ttftSeconds !== null ? Number(item.ttftSeconds.toFixed(2)) : null,
          model: item.model,
        };
        sparkline.push({
          tps: latestSample.tps,
          ttft: latestSample.ttft,
          tokens: item.outputTokens,
          model: item.model,
        });
      } else {
        excludedOutliers++;
      }
    }

    ledgerEvents.push({
      id: item.id,
      timestamp: item.timestamp,
      hasExactTimestamp: item.hasExactTimestamp,
      model: item.model,
      inputTokens: item.inputTokens,
      cacheReadTokens: item.cacheReadTokens,
      cacheWriteTokens: item.cacheWriteTokens,
      outputTokens: item.outputTokens,
      thinkingTokens: item.thinkingTokens,
      streamingSeconds: reliableTps !== null ? item.streamingSeconds : 0,
      timedOutputTokens: reliableTps !== null ? item.outputTokens : 0,
    });
  }

  const totalInputAll = totalUncachedInput + totalCacheRead + totalCacheWrite;
  const totalTokens = totalInputAll + totalOutput;
  const cacheHitRate = totalInputAll > 0 ? totalCacheRead / totalInputAll : null;
  const sessionTps = weightedStreamingSec > 0 ? weightedOutput / weightedStreamingSec : null;
  const thinkingRatio = totalOutput > 0
    ? Number(Math.max(0, Math.min(1, totalThinkingOutput / totalOutput)).toFixed(4))
    : null;

  let enrichedContext = latestContext;
  if (latestContext && deduped.size >= 2) {
    const avgTurnDelta = (totalUncachedInput + totalOutput) / deduped.size;
    const estTurns = latestContext.remainingTokens <= 0
      ? 0
      : avgTurnDelta >= 200
        ? Math.max(0, Math.min(999, Math.floor(latestContext.remainingTokens / avgTurnDelta)))
        : null;
    enrichedContext = { ...latestContext, estimatedTurnsLeft: estTurns };
  }

  const resolvedModel = latestModel || latestSample?.model || null;
  const costInfo = computeTokenCost({
    model: resolvedModel,
    inputTokens: totalUncachedInput + totalCacheWrite,
    cacheReadTokens: totalCacheRead,
    outputTokens: totalOutput,
  });

  return {
    cascadeId,
    status: String(status || ''),
    running: status === 'CASCADE_RUN_STATUS_RUNNING',
    model: resolvedModel,
    lastRequestTime,
    requests: ledgerEvents.length,
    measuredRequests,
    excludedOutliers,
    tps: sessionTps !== null ? Number(sessionTps.toFixed(1)) : null,
    latestTps: latestSample ? latestSample.tps : null,
    ttftSeconds: latestSample ? latestSample.ttft : null,
    streamingSeconds: Number(weightedStreamingSec.toFixed(2)),
    cacheHitRate: cacheHitRate !== null ? Number(cacheHitRate.toFixed(4)) : null,
    thinkingRatio,
    costUsd: costInfo ? costInfo.costUsd : null,
    cacheSavingsUsd: costInfo ? costInfo.cacheSavingsUsd : null,
    pricing: costInfo ? costInfo.pricing : null,
    tokens: {
      total: totalTokens,
      inputAll: totalInputAll,
      uncachedInput: totalUncachedInput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      output: totalOutput,
      responseOutput: totalResponseOutput,
      thinkingOutput: totalThinkingOutput,
    },
    context: enrichedContext,
    sparkline: sparkline.slice(-16),
    ledgerEvents,
  };
}
