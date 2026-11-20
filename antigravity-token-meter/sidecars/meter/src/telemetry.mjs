/**
 * Token 速率、缓存命中率、上下文窗口与模型额度计算引擎（严格输入校验版）。
 *
 * 数据边界：
 * - 内存读取：仅读取宿主 RPC 返回的数值统计、模型名称与配额比例；
 * - 绝不读取、缓存或向外透传任何 systemPrompt、对话正文、用户邮箱或令牌；
 * - 账本去重键采用局部 SHA-256 不可逆哈希，不落盘原始会话 ID 或消息 ID。
 */
import { createHash } from 'node:crypto';
import { computeTokenCost, getModelPricing, roundUsd } from './pricing.mjs';

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
    bucket.windowType,
    bucket.refreshWindow,
    bucket.refreshWindowLabel,
    bucket.displayName,
    bucket.label,
    bucket.title,
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
  const durSec = parseDurationSeconds(bucket.windowDuration ?? bucket.refreshDuration);
  if (durSec !== null && durSec > 0) {
    if (durSec <= 6 * 3600) return '5h';
    if (durSec <= 8 * 86400) return 'week';
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
  const resetTime = typeof bucket.resetTime === 'string' && Number.isFinite(Date.parse(bucket.resetTime)) ? bucket.resetTime : null;
  const kind = classifyQuotaBucket(bucket, nowMs);
  let frac = null;
  if (typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)) {
    frac = Math.max(0, Math.min(1, bucket.remainingFraction));
  } else if (typeof bucket.remainingFraction === 'string' && bucket.remainingFraction.trim() !== '') {
    const parsed = Number(bucket.remainingFraction);
    if (Number.isFinite(parsed)) frac = Math.max(0, Math.min(1, parsed));
  } else if (bucket.remainingFraction === undefined && (resetTime !== null || kind !== null)) {
    // Protobuf3 JSON 编码默认省略数值为 0 的字段：带合法 resetTime 或窗口标签但缺省 remainingFraction 时，说明该桶已耗尽（0%）
    frac = 0;
  }
  if (frac === null) return null;
  return {
    remainingFraction: frac,
    resetTime,
    windowKind: kind,
    pacing: computeQuotaPacing(frac, resetTime, kind, nowMs),
    label: typeof bucket.displayName === 'string' ? bucket.displayName.trim().slice(0, 120) : '',
  };
}

/**
 * 在分组包含多个配额桶时，将已识别的 5h/周桶配对；若恰为 2 桶且一侧已明确识别、另一侧因满血缺 resetTime 为 null，自动补位配对。
 */
function resolveDualBuckets(entries, nowMs) {
  let fiveHour = null;
  let weekly = null;
  const unknown = [];
  for (const e of entries) {
    if (e.windowKind === '5h') {
      if (!fiveHour || e.remainingFraction < fiveHour.remainingFraction) {
        fiveHour = { remainingFraction: e.remainingFraction, resetTime: e.resetTime, pacing: e.pacing };
      }
    } else if (e.windowKind === 'week') {
      if (!weekly || e.remainingFraction < weekly.remainingFraction) {
        weekly = { remainingFraction: e.remainingFraction, resetTime: e.resetTime, pacing: e.pacing };
      }
    } else {
      unknown.push(e);
    }
  }
  if (entries.length === 2 && unknown.length === 1) {
    const u = unknown[0];
    if (fiveHour && !weekly) {
      weekly = { remainingFraction: u.remainingFraction, resetTime: u.resetTime, pacing: computeQuotaPacing(u.remainingFraction, u.resetTime, 'week', nowMs) };
    } else if (weekly && !fiveHour) {
      fiveHour = { remainingFraction: u.remainingFraction, resetTime: u.resetTime, pacing: computeQuotaPacing(u.remainingFraction, u.resetTime, '5h', nowMs) };
    }
  }
  return { fiveHour, weekly };
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

    const { fiveHour, weekly } = resolveDualBuckets(entries, nowMs);

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
      const { fiveHour, weekly } = resolveDualBuckets(entries, nowMs);
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
 * 规范化模型匹配文本：统一连字符版本号（5-5 -> 5.5）、将分隔符规整为空格，并仅剥离推理强度档位后缀，
 * 保留 "(Carbon)" / "(Argon)" / "(Neon)" / "(Hydrogen)" 等真实模型代号括号。
 */
function normalizeQuotaNeedle(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/(\d)[-_](\d)(?!\d)/g, '$1.$2')
    .replace(/(\d)[-_](\d)(?!\d)/g, '$1.$2')
    .replace(/\s*\((?:x?high|medium|med|low|fast|thinking|standard|preview|beta|exp)\)\s*$/i, '')
    .replace(/[-_\s]+(?:x?high|medium|med|low)$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从模型名提取家族归属，用于在官方分组名为通用家族名（如 "Claude and GPT models" / "Gemini Models"）时精准匹配。
 */
function inferModelFamily(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return null;
  if (/\b(claude|anthropic|opus|sonnet|haiku|fable)\b/.test(s)) return 'claude_gpt';
  if (/\b(gpt|openai|o1|o3|o4|codex)\b/.test(s)) return 'claude_gpt';
  if (/\b(gemini|hydrogen|argon|carbon|neon|orchestrator)\b/.test(s)) return 'gemini';
  return null;
}

/**
 * 提取模型中的专属元素或子系列代号（如 Orchestrator (Carbon) -> carbon），以匹配按代号拆分的独立配额组。
 */
function extractSpecificCodename(name) {
  const s = String(name || '').toLowerCase();
  for (const code of ['hydrogen', 'argon', 'carbon', 'neon', 'fable', 'opus', 'sonnet', 'haiku']) {
    if (new RegExp(`\\b${code}\\b`).test(s)) return code;
  }
  if (/\borchestrator\b/.test(s)) return 'carbon';
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
    const rawFull = activeModel.trim().toLowerCase();
    const needle = normalizeQuotaNeedle(activeModel);
    const buildHay = (q) => normalizeQuotaNeedle(
      [q.title, q.leadModel, ...(Array.isArray(q.models) ? q.models : [])]
        .filter((s) => typeof s === 'string')
        .join(' ')
    );

    // 1. 优先精确/规范化子串匹配（兼容 "claude-opus-5-5-high" <-> "Claude Opus 5.5"）
    chosen = quotas.find((q) => {
      const hay = buildHay(q);
      const titleNorm = normalizeQuotaNeedle(q.title || '');
      return Boolean(needle) && (hay.includes(needle) || (titleNorm.length >= 4 && needle.includes(titleNorm)));
    }) || null;

    // 2. 按专属代号匹配（如 "Orchestrator (Carbon)" / "gemini-pro-orchestrator" -> "Gemini 4 Carbon"）
    if (!chosen) {
      const codename = extractSpecificCodename(rawFull);
      if (codename) {
        chosen = quotas.find((q) => new RegExp(`\\b${codename}\\b`).test(buildHay(q))) || null;
      }
    }

    // 3. 回退按模型家族匹配（如 "Claude Opus 5.5" / "GPT-OSS 120B" -> "Claude and GPT models"，"Orchestrator (Carbon)" -> "Gemini Models"）
    if (!chosen) {
      const fam = inferModelFamily(rawFull);
      if (fam === 'claude_gpt') {
        chosen = quotas.find((q) => /\b(claude|anthropic|gpt|openai|opus|sonnet|haiku)\b/.test(buildHay(q))) || null;
      } else if (fam === 'gemini') {
        chosen = quotas.find((q) => /\b(gemini|hydrogen|argon|carbon|neon)\b/.test(buildHay(q))) || null;
      }
    }
  }

  // 优先选同时有 5h 与周额度的分组，其次按最紧迫的组回退
  if (!chosen) {
    chosen = quotas.find((q) => q.fiveHour && q.weekly) || quotas[0];
  }

  const fiveHour = chosen.fiveHour || (chosen.windowKind === '5h' ? { remainingFraction: chosen.remainingFraction, resetTime: chosen.resetTime, pacing: chosen.pacing } : null);
  const weekly = chosen.weekly || (chosen.windowKind === 'week' ? { remainingFraction: chosen.remainingFraction, resetTime: chosen.resetTime, pacing: chosen.pacing } : null);

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
      const modelId = cfg.modelOrAlias?.model;
      const aliasId = cfg.modelOrAlias?.alias;
      const label = typeof cfg.label === 'string' ? cfg.label.trim().slice(0, 120) : '';
      if (label) {
        if (modelId) labelMap.set(String(modelId).trim().slice(0, 120), label);
        if (aliasId) labelMap.set(String(aliasId).trim().slice(0, 120), label);
      }

      const q = cfg.quotaInfo;
      if (q && typeof q === 'object') {
        const resetTime = typeof q.resetTime === 'string' && Number.isFinite(Date.parse(q.resetTime)) ? q.resetTime : null;
        let frac = null;
        if (typeof q.remainingFraction === 'number' && Number.isFinite(q.remainingFraction)) {
          frac = Math.max(0, Math.min(1, q.remainingFraction));
        } else if (q.remainingFraction === undefined && resetTime !== null) {
          frac = 0;
        }
        if (frac !== null) {
          rawQuotas.push({ label: label || 'Model', remainingFraction: frac, resetTime });
        }
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
  if (labelMap instanceof Map) {
    if (labelMap.has(key)) return labelMap.get(key);
    const keyLow = key.toLowerCase();
    for (const [k, v] of labelMap.entries()) {
      if (String(k).toLowerCase() === keyLow) return v;
    }
  }
  return key;
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
  nowMs = Date.now(),
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

    const uncachedInput = parseTokenCount(usage.inputTokens ?? usage.uncachedInputTokens) ?? 0;
    const cacheRead = parseTokenCount(usage.cacheReadTokens ?? usage.cacheReadInputTokens ?? usage.cachedContentTokenCount) ?? 0;
    const cacheWrite = parseTokenCount(usage.cacheCreationInputTokens ?? usage.cacheWriteTokens ?? usage.cacheWriteInputTokens) ?? 0;
    const responseOut = parseTokenCount(usage.responseOutputTokens ?? usage.candidatesTokenCount);
    const thinkingOut = parseTokenCount(
      usage.thinkingOutputTokens ?? usage.thinkingTokens ?? usage.thoughtsTokenCount ?? usage.reasoningTokens ?? usage.reasoningOutputTokens
    );
    const rawOut = parseTokenCount(usage.outputTokens);

    // 统一 Thinking Token 计费口径：
    // 1. 若同时存在 responseOut 与 thinkingOut，总输出取 Math.max(rawOut, responseOut + thinkingOut)，防止分离式网关仅在 outputTokens 填正文而漏算思考；
    // 2. 若仅存在 rawOut 与 thinkingOut（Antigravity LS 原生包含式），当 rawOut >= thinkingOut 时直接取 rawOut 绝不双算，当 rawOut < thinkingOut（如纯思考阶段 rawOut=0）时兜底为 thinkingOut 绝不吞零。
    const effectiveThinking = thinkingOut ?? 0;
    let effectiveOutput = 0;
    if (responseOut !== null && thinkingOut !== null) {
      effectiveOutput = Math.max(rawOut ?? 0, responseOut + thinkingOut);
    } else if (responseOut !== null) {
      effectiveOutput = Math.max(rawOut ?? 0, responseOut);
    } else if (rawOut !== null) {
      effectiveOutput = Math.max(rawOut, effectiveThinking);
    } else {
      effectiveOutput = effectiveThinking;
    }
    const effectiveResponse =
      responseOut !== null && responseOut + effectiveThinking === effectiveOutput
        ? responseOut
        : Math.max(0, effectiveOutput - effectiveThinking);

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
    const rawEndTs = [cm.endTime, cm.completionTime, cm.responseTime, cm.updatedAt]
      .find((v) => typeof v === 'string' && Number.isFinite(Date.parse(v))) || null;
    const hasExactTimestamp = Boolean(rawTs);
    const ts = rawTs || fallbackDate;

    const candidate = {
      id: hashedKey,
      timestamp: ts,
      endTimestamp: rawEndTs,
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
    };

    const prev = deduped.get(hashedKey);
    if (!prev) {
      deduped.set(hashedKey, candidate);
    } else {
      // 合并同一请求的多帧快照：单调保留更大计数值与已测流式时长/精确时间戳，防乱序冲掉关键字段
      const prevSum = prev.inputTokens + prev.cacheReadTokens + prev.cacheWriteTokens + prev.outputTokens;
      const nextSum = candidate.inputTokens + candidate.cacheReadTokens + candidate.cacheWriteTokens + candidate.outputTokens;
      const mergedOut = Math.max(prev.outputTokens, candidate.outputTokens);
      const mergedThink = Math.max(prev.thinkingTokens, candidate.thinkingTokens);
      const mergedResp = nextSum > prevSum && responseOut !== null && responseOut + mergedThink === mergedOut
        ? candidate.responseOutputTokens
        : Math.max(0, mergedOut - mergedThink);
      deduped.set(hashedKey, {
        id: hashedKey,
        timestamp: candidate.hasExactTimestamp ? candidate.timestamp : prev.timestamp,
        endTimestamp: candidate.endTimestamp || prev.endTimestamp,
        hasExactTimestamp: candidate.hasExactTimestamp || prev.hasExactTimestamp,
        model: candidate.model !== 'Unknown' ? candidate.model : prev.model,
        inputTokens: Math.max(prev.inputTokens, candidate.inputTokens),
        cacheReadTokens: Math.max(prev.cacheReadTokens, candidate.cacheReadTokens),
        cacheWriteTokens: Math.max(prev.cacheWriteTokens, candidate.cacheWriteTokens),
        outputTokens: mergedOut,
        responseOutputTokens: mergedResp,
        thinkingTokens: mergedThink,
        streamingSeconds: candidate.streamingSeconds ?? prev.streamingSeconds,
        ttftSeconds: candidate.ttftSeconds ?? prev.ttftSeconds,
      });
    }
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
  let latestPromptTokens = 0;
  let latestCacheHitRate = null;
  let lastRequestMs = 0;
  let lastRequestTime = null;
  let totalCostUsd = 0;
  let totalCacheSavingsUsd = 0;
  const turnPrompts = [];
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

    const stepPromptTokens = item.inputTokens + item.cacheWriteTokens + item.cacheReadTokens;
    latestPromptTokens = stepPromptTokens;
    latestCacheHitRate = stepPromptTokens > 0
      ? Number((item.cacheReadTokens / stepPromptTokens).toFixed(4))
      : null;
    turnPrompts.push(stepPromptTokens);

    const itemStartMs = Date.parse(item.timestamp);
    // 计算请求真实活跃结束时刻（用于 Prompt Cache 保鲜度，避免长思考 4~10 分钟刚结束即被误判为缓存过期）
    let itemActiveMs = itemStartMs;
    if (item.endTimestamp) {
      const endMs = Date.parse(item.endTimestamp);
      if (Number.isFinite(endMs) && (!Number.isFinite(itemStartMs) || endMs >= itemStartMs)) {
        itemActiveMs = endMs;
      }
    } else if (Number.isFinite(itemStartMs) && item.streamingSeconds !== null && item.streamingSeconds > 0) {
      const estEndMs = itemStartMs + Math.round(item.streamingSeconds * 1000);
      itemActiveMs = itemStartMs <= nowMs ? Math.min(nowMs, estEndMs) : estEndMs;
    }

    if (Number.isFinite(itemActiveMs) && itemActiveMs >= lastRequestMs) {
      lastRequestMs = itemActiveMs;
      lastRequestTime = new Date(itemActiveMs).toISOString();
    }

    const stepCost = computeTokenCost({
      model: item.model,
      inputTokens: item.inputTokens + item.cacheWriteTokens,
      cacheReadTokens: item.cacheReadTokens,
      outputTokens: item.outputTokens,
      promptTokens: stepPromptTokens,
    }, Number.isFinite(itemStartMs) ? itemStartMs : nowMs);
    if (stepCost) {
      totalCostUsd += stepCost.costUsd;
      totalCacheSavingsUsd += stepCost.cacheSavingsUsd;
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

  const isRunning = status === 'CASCADE_RUN_STATUS_RUNNING';
  if (isRunning && deduped.size > 0 && Number.isFinite(nowMs)) {
    // 正在流式生成中的对话上下文处于实时热连接保鲜态
    if (nowMs >= lastRequestMs) {
      lastRequestMs = nowMs;
      lastRequestTime = new Date(nowMs).toISOString();
    }
  }

  const totalInputAll = totalUncachedInput + totalCacheRead + totalCacheWrite;
  const totalTokens = totalInputAll + totalOutput;
  const cacheHitRate = totalInputAll > 0 ? totalCacheRead / totalInputAll : null;
  const sessionTps = weightedStreamingSec > 0 ? weightedOutput / weightedStreamingSec : null;
  const thinkingRatio = totalOutput > 0
    ? Number(Math.max(0, Math.min(1, totalThinkingOutput / totalOutput)).toFixed(4))
    : null;

  let enrichedContext = latestContext;
  if (latestContext) {
    if (latestContext.remainingTokens <= 0) {
      enrichedContext = { ...latestContext, estimatedTurnsLeft: 0 };
    } else if (deduped.size >= 2) {
      // 优先提取相邻轮次总上下文正向净增长量（免疫缓存过期重算虚增 uncachedInput 与 Claude cacheWrite 归类差异）
      const growthSamples = [];
      for (let k = 1; k < turnPrompts.length; k++) {
        const diff = turnPrompts[k] - turnPrompts[k - 1];
        if (diff > 0) growthSamples.push(diff);
      }
      const recentGrowth = growthSamples.slice(-8);
      const avgTurnDelta = recentGrowth.length > 0
        ? recentGrowth.reduce((a, b) => a + b, 0) / recentGrowth.length
        : (totalUncachedInput + totalCacheWrite + totalOutput) / deduped.size;

      const estTurns = avgTurnDelta >= 200
        ? Math.max(0, Math.min(999, Math.floor(latestContext.remainingTokens / avgTurnDelta)))
        : null;
      enrichedContext = { ...latestContext, estimatedTurnsLeft: estTurns };
    }
  }

  const resolvedModel = latestModel || latestSample?.model || null;
  const effectiveCtxTokens = Math.max(latestPromptTokens, latestContext?.usedTokens ?? 0);
  const resolvedPricing = resolvedModel
    ? getModelPricing(resolvedModel, lastRequestMs > 0 ? lastRequestMs : nowMs, { promptTokens: effectiveCtxTokens })
    : null;

  return {
    cascadeId,
    status: String(status || ''),
    running: isRunning,
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
    latestCacheHitRate,
    thinkingRatio,
    costUsd: ledgerEvents.length > 0 ? roundUsd(totalCostUsd) : null,
    cacheSavingsUsd: ledgerEvents.length > 0 ? roundUsd(totalCacheSavingsUsd) : null,
    pricing: resolvedPricing,
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
