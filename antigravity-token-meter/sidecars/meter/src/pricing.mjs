/**
 * 模型官方 API 实时参考计价表与美元费用估算引擎（USD / 1M Tokens）。
 * 依据 Google AI Studio (Gemini API) 与 Anthropic Claude API 公开标准按量计费标准，
 * 支持按当前时间戳自动切换分阶段生效费率（如 Argon / Carbon 2026-12-01 阶梯）。
 */

const DEC_2026_MS = Date.UTC(2026, 11, 1); // 2026-12-01T00:00:00Z
const JAN_2027_MS = Date.UTC(2027, 0, 1);  // 2027-01-01T00:00:00Z

/**
 * 根据模型展示名或模型 ID 解析单价（美元 / 1M Tokens）。
 * @param {string} modelName
 * @param {number} [nowMs]
 */
export function getModelPricing(modelName, nowMs = Date.now()) {
  const s = String(modelName || '').toLowerCase();

  if (s.includes('hydrogen')) {
    return { family: 'Gemini 4 Hydrogen', inputPer1M: 1.5, cacheReadPer1M: 0.075, outputPer1M: 7.5, exact: true };
  }
  if (s.includes('argon')) {
    const postIntro = nowMs >= DEC_2026_MS;
    return {
      family: 'Gemini 4 Argon',
      inputPer1M: postIntro ? 4.0 : 2.0,
      cacheReadPer1M: postIntro ? 0.2 : 0.1,
      outputPer1M: postIntro ? 20.0 : 10.0,
      exact: true,
    };
  }
  if (s.includes('carbon')) {
    const postIntro = nowMs >= DEC_2026_MS;
    return {
      family: 'Gemini 4 Carbon',
      inputPer1M: postIntro ? 4.0 : 2.0,
      cacheReadPer1M: postIntro ? 0.2 : 0.1,
      outputPer1M: postIntro ? 20.0 : 10.0,
      exact: true,
    };
  }
  if (s.includes('neon')) {
    return { family: 'Gemini 4 Neon', inputPer1M: 3.0, cacheReadPer1M: 0.15, outputPer1M: 15.0, exact: true };
  }
  if (s.includes('3.8') && s.includes('flash')) {
    const postIntro = nowMs >= JAN_2027_MS;
    return {
      family: 'Gemini 3.8 Flash',
      inputPer1M: postIntro ? 1.5 : 0.75,
      cacheReadPer1M: postIntro ? 0.15 : 0.075,
      outputPer1M: postIntro ? 7.5 : 3.75,
      exact: true,
    };
  }
  if (s.includes('3.6') && s.includes('flash')) {
    const postIntro = nowMs >= JAN_2027_MS;
    return {
      family: 'Gemini 3.6 Flash',
      inputPer1M: postIntro ? 1.5 : 0.75,
      cacheReadPer1M: postIntro ? 0.15 : 0.075,
      outputPer1M: postIntro ? 7.5 : 3.75,
      exact: true,
    };
  }
  if (s.includes('3.5') && s.includes('flash-lite')) {
    return { family: 'Gemini 3.5 Flash-Lite', inputPer1M: 0.3, cacheReadPer1M: 0.03, outputPer1M: 2.5, exact: true };
  }
  if (s.includes('3.5') && s.includes('flash')) {
    return { family: 'Gemini 3.5 Flash', inputPer1M: 1.5, cacheReadPer1M: 0.15, outputPer1M: 9.0, exact: true };
  }
  if (s.includes('flash-lite')) {
    return { family: 'Gemini Flash-Lite', inputPer1M: 0.3, cacheReadPer1M: 0.03, outputPer1M: 2.5, exact: true };
  }
  if (s.includes('flash')) {
    return { family: 'Gemini Flash', inputPer1M: 0.75, cacheReadPer1M: 0.075, outputPer1M: 3.75, exact: false };
  }
  if (s.includes('fable') && s.includes('5.1')) {
    return { family: 'Claude Fable 5.1', inputPer1M: 10.0, cacheReadPer1M: 0.25, outputPer1M: 50.0, exact: true };
  }
  if (s.includes('fable') && s.includes('5.2')) {
    return { family: 'Claude Fable 5.2', inputPer1M: 8.0, cacheReadPer1M: 0.2, outputPer1M: 40.0, exact: true };
  }
  if (s.includes('opus') && s.includes('5.5')) {
    return { family: 'Claude Opus 5.5', inputPer1M: 4.0, cacheReadPer1M: 0.2, outputPer1M: 20.0, exact: true };
  }
  if (s.includes('opus') && s.includes('4.6')) {
    return { family: 'Claude Opus 4.6', inputPer1M: 5.0, cacheReadPer1M: 0.5, outputPer1M: 25.0, exact: true };
  }
  if (s.includes('sonnet') && s.includes('5.5')) {
    return { family: 'Claude Sonnet 5.5', inputPer1M: 2.0, cacheReadPer1M: 0.1, outputPer1M: 10.0, exact: true };
  }
  if (s.includes('haiku') && s.includes('5.5')) {
    return { family: 'Claude Haiku 5.5', inputPer1M: 0.1, cacheReadPer1M: 0.01, outputPer1M: 0.5, exact: true };
  }
  if (s.includes('opus')) {
    return { family: 'Claude Opus', inputPer1M: 5.0, cacheReadPer1M: 0.5, outputPer1M: 25.0, exact: false };
  }
  if (s.includes('sonnet')) {
    return { family: 'Claude Sonnet', inputPer1M: 3.0, cacheReadPer1M: 0.3, outputPer1M: 15.0, exact: false };
  }
  if (s.includes('haiku')) {
    return { family: 'Claude Haiku', inputPer1M: 0.25, cacheReadPer1M: 0.025, outputPer1M: 1.25, exact: false };
  }
  return { family: 'Default Reference', inputPer1M: 1.5, cacheReadPer1M: 0.15, outputPer1M: 7.5, exact: false };
}

function nn(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 按未缓存输入、缓存读取、输出（含思考）精确估算单次/累计美元花费及缓存节省金额。
 * @param {{ model?: string, inputTokens?: number, cacheReadTokens?: number, outputTokens?: number }} usage
 * @param {number} [nowMs]
 */
export function computeTokenCost({ model = '', inputTokens = 0, cacheReadTokens = 0, outputTokens = 0 }, nowMs = Date.now()) {
  const p = getModelPricing(model, nowMs);
  const uIn = nn(inputTokens);
  const cRead = nn(cacheReadTokens);
  const out = nn(outputTokens);
  const costUsd = (uIn * p.inputPer1M + cRead * p.cacheReadPer1M + out * p.outputPer1M) / 1e6;
  const cacheSavingsUsd = Math.max(0, (cRead * (p.inputPer1M - p.cacheReadPer1M)) / 1e6);
  return {
    costUsd: Number(costUsd.toFixed(6)),
    cacheSavingsUsd: Number(cacheSavingsUsd.toFixed(6)),
    pricing: p,
  };
}
