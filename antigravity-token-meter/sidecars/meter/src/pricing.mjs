/**
 * 模型官方 API 实时参考计价表与美元费用估算引擎（USD / 1M Tokens）。
 * 依据 Google AI Studio (Gemini API)、Anthropic Claude API 与 OpenAI API 公开按量计费标准：
 * - 支持按时间戳自动切换分阶段生效费率（如 Argon / Carbon 2026-12-01、3.6/3.8 Flash 2027-01-01 阶梯）；
 * - 支持 >200k 长上下文阶梯单价（Gemini Pro / Gemini 4 旗舰系 / Claude Sonnet & Opus & Fable 在单次输入超 200k 时触发高阶费率）；
 * - 兼容连字符/下划线模型 ID（如 claude-opus-5-5-high、gemini-pro-orchestrator）与展示名，严防高价模型误落低价档；
 * - 保留 9 位十进制有效小数精度并彻底消除 -0，确保微额消费（<$0.01 乃至单 Token）不截断归零、多步累加零漂移。
 */

export const LONG_CONTEXT_THRESHOLD_TOKENS = 200_000;

const DEC_2026_MS = Date.UTC(2026, 11, 1); // 2026-12-01T00:00:00Z
const JAN_2027_MS = Date.UTC(2027, 0, 1);  // 2027-01-01T00:00:00Z

function nn(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 归一化非负美元金额：消除 IEEE-754 浮点毛刺与 -0，同时完整保留 $/1M 三位小数单价除以 1e6 后的 9 位十进制精度。
 * @param {unknown} value
 * @returns {number}
 */
export function roundUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const rounded = Number(n.toFixed(9));
  return rounded > 0 ? rounded : 0;
}

/**
 * 将模型名统一转为小写并将数字间的连字符/下划线规整为小数点（如 claude-opus-5-5-high -> claude-opus-5.5-high）。
 * @param {unknown} modelName
 * @returns {string}
 */
function normalizeModelSlug(modelName) {
  return String(modelName || '')
    .trim()
    .toLowerCase()
    .replace(/(\d)[-_](\d)(?!\d)/g, '$1.$2')
    .replace(/(\d)[-_](\d)(?!\d)/g, '$1.$2');
}

function hasVersion(slug, ver) {
  const escaped = ver.replace(/\./g, '\\.');
  return new RegExp(`(?:^|[^0-9.])${escaped}(?:$|[^0-9.])`).test(slug);
}

/**
 * 构建带标准 >200k 长上下文阶梯（官方标准：输入 2x、缓存读取 2x、输出 1.5x）的定价规格。
 */
function standardLongContext(inputPer1M, cacheReadPer1M, outputPer1M) {
  return {
    threshold: LONG_CONTEXT_THRESHOLD_TOKENS,
    inputPer1M: Number((inputPer1M * 2).toFixed(6)),
    cacheReadPer1M: Number((cacheReadPer1M * 2).toFixed(6)),
    outputPer1M: Number((outputPer1M * 1.5).toFixed(6)),
  };
}

function finalizePricing(spec, promptTokens = 0) {
  const pTok = nn(promptTokens);
  const lc = spec.longContext || null;
  const applied = Boolean(lc && pTok > lc.threshold);
  const inputPer1M = applied ? lc.inputPer1M : spec.inputPer1M;
  const cacheReadPer1M = applied ? lc.cacheReadPer1M : spec.cacheReadPer1M;
  const outputPer1M = applied ? lc.outputPer1M : spec.outputPer1M;

  const out = {
    family: spec.family,
    inputPer1M,
    cacheReadPer1M,
    outputPer1M,
    baseInputPer1M: spec.inputPer1M,
    baseCacheReadPer1M: spec.cacheReadPer1M,
    baseOutputPer1M: spec.outputPer1M,
    exact: Boolean(spec.exact),
    unknown: Boolean(spec.unknown),
    longContextThreshold: lc ? lc.threshold : null,
    longContextApplied: applied,
  };
  if (lc) {
    out.longContextPricing = {
      inputPer1M: lc.inputPer1M,
      cacheReadPer1M: lc.cacheReadPer1M,
      outputPer1M: lc.outputPer1M,
    };
  }
  return out;
}

/**
 * 根据模型展示名或模型 ID 解析单价（美元 / 1M Tokens）。
 * @param {string} modelName
 * @param {number} [nowMs]
 * @param {{ promptTokens?: number }} [options]
 */
export function getModelPricing(modelName, nowMs = Date.now(), options = undefined) {
  const s = normalizeModelSlug(modelName);
  const ts = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
  const promptTokens = options && typeof options === 'object' ? nn(options.promptTokens) : 0;

  // 1. Anthropic Claude 高阶家族优先（Fable -> Opus -> Sonnet -> Haiku），严防高价模型被后续低价关键词抢占
  if (s.includes('fable')) {
    if (hasVersion(s, '5.1')) {
      return finalizePricing({
        family: 'Claude Fable 5.1',
        inputPer1M: 10.0,
        cacheReadPer1M: 0.25,
        outputPer1M: 50.0,
        exact: true,
        longContext: standardLongContext(10.0, 0.25, 50.0),
      }, promptTokens);
    }
    if (hasVersion(s, '5.2')) {
      return finalizePricing({
        family: 'Claude Fable 5.2',
        inputPer1M: 8.0,
        cacheReadPer1M: 0.2,
        outputPer1M: 40.0,
        exact: true,
        longContext: standardLongContext(8.0, 0.2, 40.0),
      }, promptTokens);
    }
    return finalizePricing({
      family: 'Claude Fable',
      inputPer1M: 8.0,
      cacheReadPer1M: 0.2,
      outputPer1M: 40.0,
      exact: false,
      longContext: standardLongContext(8.0, 0.2, 40.0),
    }, promptTokens);
  }

  if (s.includes('opus')) {
    if (hasVersion(s, '5.5')) {
      return finalizePricing({
        family: 'Claude Opus 5.5',
        inputPer1M: 4.0,
        cacheReadPer1M: 0.2,
        outputPer1M: 20.0,
        exact: true,
        longContext: standardLongContext(4.0, 0.2, 20.0),
      }, promptTokens);
    }
    if (hasVersion(s, '4.6') || hasVersion(s, '4.5')) {
      return finalizePricing({
        family: hasVersion(s, '4.5') ? 'Claude Opus 4.5' : 'Claude Opus 4.6',
        inputPer1M: 5.0,
        cacheReadPer1M: 0.5,
        outputPer1M: 25.0,
        exact: true,
        longContext: standardLongContext(5.0, 0.5, 25.0),
      }, promptTokens);
    }
    if (hasVersion(s, '4.1') || hasVersion(s, '4.0') || hasVersion(s, '4') || hasVersion(s, '3') || hasVersion(s, '3.0')) {
      return finalizePricing({
        family: 'Claude Opus 4.x',
        inputPer1M: 15.0,
        cacheReadPer1M: 1.5,
        outputPer1M: 75.0,
        exact: true,
        longContext: standardLongContext(15.0, 1.5, 75.0),
      }, promptTokens);
    }
    return finalizePricing({
      family: 'Claude Opus',
      inputPer1M: 5.0,
      cacheReadPer1M: 0.5,
      outputPer1M: 25.0,
      exact: false,
      longContext: standardLongContext(5.0, 0.5, 25.0),
    }, promptTokens);
  }

  // 2. Google Gemini 4 元素代号系与 Orchestrator 映射（元素代号优先于通用 orchestrator）
  if (s.includes('hydrogen')) {
    return finalizePricing({
      family: 'Gemini 4 Hydrogen',
      inputPer1M: 1.5,
      cacheReadPer1M: 0.075,
      outputPer1M: 7.5,
      exact: true,
      longContext: standardLongContext(1.5, 0.075, 7.5),
    }, promptTokens);
  }
  if (s.includes('argon')) {
    const postIntro = ts >= DEC_2026_MS;
    const baseIn = postIntro ? 4.0 : 2.0;
    const baseCr = postIntro ? 0.2 : 0.1;
    const baseOut = postIntro ? 20.0 : 10.0;
    return finalizePricing({
      family: 'Gemini 4 Argon',
      inputPer1M: baseIn,
      cacheReadPer1M: baseCr,
      outputPer1M: baseOut,
      exact: true,
      longContext: standardLongContext(baseIn, baseCr, baseOut),
    }, promptTokens);
  }
  if (s.includes('neon')) {
    return finalizePricing({
      family: 'Gemini 4 Neon',
      inputPer1M: 3.0,
      cacheReadPer1M: 0.15,
      outputPer1M: 15.0,
      exact: true,
      longContext: standardLongContext(3.0, 0.15, 15.0),
    }, promptTokens);
  }
  if (s.includes('carbon') || s.includes('orchestrator')) {
    // Antigravity 官方 gemini-pro-orchestrator 展示名为 "Orchestrator (Carbon)"，在排除 Hydrogen/Argon/Neon 后对应 Carbon 费率
    const postIntro = ts >= DEC_2026_MS;
    const baseIn = postIntro ? 4.0 : 2.0;
    const baseCr = postIntro ? 0.2 : 0.1;
    const baseOut = postIntro ? 20.0 : 10.0;
    return finalizePricing({
      family: 'Gemini 4 Carbon',
      inputPer1M: baseIn,
      cacheReadPer1M: baseCr,
      outputPer1M: baseOut,
      exact: true,
      longContext: standardLongContext(baseIn, baseCr, baseOut),
    }, promptTokens);
  }

  // 3. Anthropic Claude Sonnet & Haiku 全系列
  if (s.includes('sonnet')) {
    if (hasVersion(s, '5.5')) {
      return finalizePricing({
        family: 'Claude Sonnet 5.5',
        inputPer1M: 2.0,
        cacheReadPer1M: 0.1,
        outputPer1M: 10.0,
        exact: true,
        longContext: standardLongContext(2.0, 0.1, 10.0),
      }, promptTokens);
    }
    if (
      hasVersion(s, '4.6') || hasVersion(s, '4.5') || hasVersion(s, '4.0') ||
      hasVersion(s, '4') || hasVersion(s, '3.7') || hasVersion(s, '3.5')
    ) {
      return finalizePricing({
        family: 'Claude Sonnet 4.x',
        inputPer1M: 3.0,
        cacheReadPer1M: 0.3,
        outputPer1M: 15.0,
        exact: true,
        longContext: standardLongContext(3.0, 0.3, 15.0),
      }, promptTokens);
    }
    return finalizePricing({
      family: 'Claude Sonnet',
      inputPer1M: 3.0,
      cacheReadPer1M: 0.3,
      outputPer1M: 15.0,
      exact: false,
      longContext: standardLongContext(3.0, 0.3, 15.0),
    }, promptTokens);
  }

  if (s.includes('haiku')) {
    if (hasVersion(s, '5.5')) {
      return finalizePricing({ family: 'Claude Haiku 5.5', inputPer1M: 0.1, cacheReadPer1M: 0.01, outputPer1M: 0.5, exact: true }, promptTokens);
    }
    if (hasVersion(s, '4.5')) {
      return finalizePricing({ family: 'Claude Haiku 4.5', inputPer1M: 1.0, cacheReadPer1M: 0.1, outputPer1M: 5.0, exact: true }, promptTokens);
    }
    if (hasVersion(s, '3.5')) {
      return finalizePricing({ family: 'Claude Haiku 3.5', inputPer1M: 0.8, cacheReadPer1M: 0.08, outputPer1M: 4.0, exact: true }, promptTokens);
    }
    return finalizePricing({ family: 'Claude Haiku', inputPer1M: 0.25, cacheReadPer1M: 0.025, outputPer1M: 1.25, exact: false }, promptTokens);
  }

  // 4. OpenAI GPT-OSS / o 系列推理模型 / GPT 系列（细分 mini/nano 优先于同代主型号）
  if (s.includes('gpt-oss') || s.includes('gpt oss')) {
    return finalizePricing({ family: 'GPT-OSS 120B', inputPer1M: 0.15, cacheReadPer1M: 0.075, outputPer1M: 0.6, exact: true }, promptTokens);
  }
  if (/\bo1[._\s-]?pro\b/.test(s)) {
    return finalizePricing({ family: 'OpenAI o1-pro', inputPer1M: 150.0, cacheReadPer1M: 150.0, outputPer1M: 600.0, exact: true }, promptTokens);
  }
  if (/\bo3[._\s-]?pro\b/.test(s)) {
    return finalizePricing({ family: 'OpenAI o3-pro', inputPer1M: 20.0, cacheReadPer1M: 20.0, outputPer1M: 80.0, exact: true }, promptTokens);
  }
  if (/\b(o1|o3|o4)[._\s-]?mini\b/.test(s)) {
    return finalizePricing({ family: 'OpenAI o-mini', inputPer1M: 1.1, cacheReadPer1M: 0.275, outputPer1M: 4.4, exact: true }, promptTokens);
  }
  if (/\bo3\b/.test(s)) {
    return finalizePricing({ family: 'OpenAI o3', inputPer1M: 2.0, cacheReadPer1M: 0.5, outputPer1M: 8.0, exact: true }, promptTokens);
  }
  if (/\bo1\b/.test(s)) {
    return finalizePricing({ family: 'OpenAI o1', inputPer1M: 15.0, cacheReadPer1M: 7.5, outputPer1M: 60.0, exact: true }, promptTokens);
  }
  if (/\bo4\b/.test(s)) {
    return finalizePricing({ family: 'OpenAI o4-mini', inputPer1M: 1.1, cacheReadPer1M: 0.275, outputPer1M: 4.4, exact: false }, promptTokens);
  }
  if (/\bgpt\b|gpt[-_.]/.test(s) || /\bcodex\b/.test(s)) {
    if (s.includes('nano')) {
      return finalizePricing({ family: 'OpenAI GPT nano', inputPer1M: 0.1, cacheReadPer1M: 0.025, outputPer1M: 0.4, exact: true }, promptTokens);
    }
    if (s.includes('4o') && s.includes('mini')) {
      return finalizePricing({ family: 'OpenAI GPT-4o mini', inputPer1M: 0.15, cacheReadPer1M: 0.075, outputPer1M: 0.6, exact: true }, promptTokens);
    }
    if (hasVersion(s, '4.1') && s.includes('mini')) {
      return finalizePricing({ family: 'OpenAI GPT-4.1 mini', inputPer1M: 0.4, cacheReadPer1M: 0.1, outputPer1M: 1.6, exact: true }, promptTokens);
    }
    if (s.includes('mini')) {
      return finalizePricing({ family: 'OpenAI GPT mini', inputPer1M: 0.25, cacheReadPer1M: 0.025, outputPer1M: 2.0, exact: true }, promptTokens);
    }
    if (s.includes('4o')) {
      return finalizePricing({ family: 'OpenAI GPT-4o', inputPer1M: 2.5, cacheReadPer1M: 1.25, outputPer1M: 10.0, exact: true }, promptTokens);
    }
    if (hasVersion(s, '4.1')) {
      return finalizePricing({ family: 'OpenAI GPT-4.1', inputPer1M: 2.0, cacheReadPer1M: 0.5, outputPer1M: 8.0, exact: true }, promptTokens);
    }
    if (/\bcodex\b/.test(s) || /\bgpt[-_.\s]*(5|6)\b/.test(s) || hasVersion(s, '5.1') || hasVersion(s, '5.2') || hasVersion(s, '5.3') || hasVersion(s, '5.4') || hasVersion(s, '6.1')) {
      return finalizePricing({ family: 'OpenAI GPT-5 / Codex', inputPer1M: 1.75, cacheReadPer1M: 0.175, outputPer1M: 14.0, exact: true }, promptTokens);
    }
    return finalizePricing({ family: 'OpenAI GPT', inputPer1M: 2.0, cacheReadPer1M: 0.5, outputPer1M: 8.0, exact: false }, promptTokens);
  }

  // 5. Google Gemini Flash-Lite -> Flash -> Pro 系列（Flash-Lite 严格在 Flash 之前）
  if (s.includes('flash-lite') || s.includes('flash lite')) {
    if (hasVersion(s, '3.5')) {
      return finalizePricing({ family: 'Gemini 3.5 Flash-Lite', inputPer1M: 0.3, cacheReadPer1M: 0.03, outputPer1M: 2.5, exact: true }, promptTokens);
    }
    if (hasVersion(s, '2.5')) {
      return finalizePricing({ family: 'Gemini 2.5 Flash-Lite', inputPer1M: 0.1, cacheReadPer1M: 0.01, outputPer1M: 0.4, exact: true }, promptTokens);
    }
    if (hasVersion(s, '2.0') || hasVersion(s, '2')) {
      return finalizePricing({ family: 'Gemini 2.0 Flash-Lite', inputPer1M: 0.075, cacheReadPer1M: 0.01875, outputPer1M: 0.3, exact: true }, promptTokens);
    }
    return finalizePricing({ family: 'Gemini Flash-Lite', inputPer1M: 0.3, cacheReadPer1M: 0.03, outputPer1M: 2.5, exact: true }, promptTokens);
  }

  if (s.includes('flash')) {
    if (hasVersion(s, '3.8')) {
      const postIntro = ts >= JAN_2027_MS;
      return finalizePricing({
        family: 'Gemini 3.8 Flash',
        inputPer1M: postIntro ? 1.5 : 0.75,
        cacheReadPer1M: postIntro ? 0.15 : 0.075,
        outputPer1M: postIntro ? 7.5 : 3.75,
        exact: true,
      }, promptTokens);
    }
    if (hasVersion(s, '3.6')) {
      const postIntro = ts >= JAN_2027_MS;
      return finalizePricing({
        family: 'Gemini 3.6 Flash',
        inputPer1M: postIntro ? 1.5 : 0.75,
        cacheReadPer1M: postIntro ? 0.15 : 0.075,
        outputPer1M: postIntro ? 7.5 : 3.75,
        exact: true,
      }, promptTokens);
    }
    if (hasVersion(s, '3.5')) {
      return finalizePricing({ family: 'Gemini 3.5 Flash', inputPer1M: 1.5, cacheReadPer1M: 0.15, outputPer1M: 9.0, exact: true }, promptTokens);
    }
    if (hasVersion(s, '3.0') || hasVersion(s, '3')) {
      return finalizePricing({ family: 'Gemini 3 Flash', inputPer1M: 0.5, cacheReadPer1M: 0.05, outputPer1M: 3.0, exact: true }, promptTokens);
    }
    if (hasVersion(s, '2.5')) {
      return finalizePricing({ family: 'Gemini 2.5 Flash', inputPer1M: 0.3, cacheReadPer1M: 0.03, outputPer1M: 2.5, exact: true }, promptTokens);
    }
    if (hasVersion(s, '2.0') || hasVersion(s, '2')) {
      return finalizePricing({ family: 'Gemini 2.0 Flash', inputPer1M: 0.1, cacheReadPer1M: 0.025, outputPer1M: 0.4, exact: true }, promptTokens);
    }
    return finalizePricing({ family: 'Gemini Flash', inputPer1M: 0.75, cacheReadPer1M: 0.075, outputPer1M: 3.75, exact: false }, promptTokens);
  }

  if (s.includes('gemini') && /\bpro\b|[-_.]pro(?:$|[-_.])/.test(s)) {
    if (hasVersion(s, '2.5')) {
      return finalizePricing({
        family: 'Gemini 2.5 Pro',
        inputPer1M: 1.25,
        cacheReadPer1M: 0.125,
        outputPer1M: 10.0,
        exact: true,
        longContext: standardLongContext(1.25, 0.125, 10.0),
      }, promptTokens);
    }
    if (hasVersion(s, '3.5') || hasVersion(s, '3.1') || hasVersion(s, '3.0') || hasVersion(s, '3')) {
      return finalizePricing({
        family: 'Gemini 3 Pro',
        inputPer1M: 2.0,
        cacheReadPer1M: 0.2,
        outputPer1M: 12.0,
        exact: true,
        longContext: standardLongContext(2.0, 0.2, 12.0),
      }, promptTokens);
    }
    return finalizePricing({
      family: 'Gemini Pro',
      inputPer1M: 2.0,
      cacheReadPer1M: 0.2,
      outputPer1M: 12.0,
      exact: false,
      longContext: standardLongContext(2.0, 0.2, 12.0),
    }, promptTokens);
  }

  // 6. 品牌级泛匹配与未知模型显式标记兜底
  if (/\b(claude|anthropic)\b/.test(s)) {
    return finalizePricing({
      family: 'Claude Sonnet',
      inputPer1M: 3.0,
      cacheReadPer1M: 0.3,
      outputPer1M: 15.0,
      exact: false,
      longContext: standardLongContext(3.0, 0.3, 15.0),
    }, promptTokens);
  }
  if (/\bopenai\b/.test(s)) {
    return finalizePricing({ family: 'OpenAI GPT', inputPer1M: 2.0, cacheReadPer1M: 0.5, outputPer1M: 8.0, exact: false }, promptTokens);
  }
  if (/\bgemini\b/.test(s)) {
    return finalizePricing({ family: 'Gemini Reference', inputPer1M: 1.5, cacheReadPer1M: 0.15, outputPer1M: 7.5, exact: false }, promptTokens);
  }

  return finalizePricing({
    family: 'Default Reference',
    inputPer1M: 1.5,
    cacheReadPer1M: 0.15,
    outputPer1M: 7.5,
    exact: false,
    unknown: true,
  }, promptTokens);
}

/**
 * 按未缓存输入（含缓存写入）、缓存读取、输出（含思考）精确估算单次或聚合美元花费及缓存节省金额。
 * - 当传入单步 `promptTokens`（或 `requests` 以折算单次平均上下文）且超过 200k 时，对适用模型自动启用 >200k 长上下文阶梯费率；
 * - 严格保证非负与零 -0.00，保留 9 位十进制精度不截断小额花费。
 *
 * @param {{
 *   model?: string,
 *   inputTokens?: number,
 *   cacheReadTokens?: number,
 *   outputTokens?: number,
 *   promptTokens?: number,
 *   requests?: number
 * }} [usage]
 * @param {number} [nowMs]
 */
export function computeTokenCost(
  {
    model = '',
    inputTokens = 0,
    cacheReadTokens = 0,
    outputTokens = 0,
    promptTokens = undefined,
    requests = undefined,
  } = {},
  nowMs = Date.now()
) {
  const uIn = nn(inputTokens);
  const cRead = nn(cacheReadTokens);
  const out = nn(outputTokens);

  let effectivePromptTokens = 0;
  if (promptTokens !== undefined && promptTokens !== null) {
    effectivePromptTokens = nn(promptTokens);
  } else if (requests !== undefined && requests !== null && nn(requests) > 0) {
    effectivePromptTokens = (uIn + cRead) / nn(requests);
  }

  const p = getModelPricing(model, nowMs, { promptTokens: effectivePromptTokens });
  const costUsd = (uIn * p.inputPer1M + cRead * p.cacheReadPer1M + out * p.outputPer1M) / 1e6;
  const unitSaving = Math.max(0, p.inputPer1M - p.cacheReadPer1M);
  const cacheSavingsUsd = (cRead * unitSaving) / 1e6;

  return {
    costUsd: roundUsd(costUsd),
    cacheSavingsUsd: roundUsd(cacheSavingsUsd),
    pricing: p,
  };
}
