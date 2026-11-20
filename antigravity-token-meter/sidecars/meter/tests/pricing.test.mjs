import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTokenCost, getModelPricing, roundUsd, LONG_CONTEXT_THRESHOLD_TOKENS } from '../src/pricing.mjs';
import { computeConversationTelemetry } from '../src/telemetry.mjs';
import { UsageLedger } from '../src/ledger.mjs';

test('getModelPricing 与 computeTokenCost 覆盖全部真实模型 ID / 展示名 / 连字符变体并严防高价模型误判', () => {
  const preDec = Date.UTC(2026, 10, 19); // 2026-11-19
  const postDec = Date.UTC(2026, 11, 2); // 2026-12-02
  const postJan = Date.UTC(2027, 0, 5);  // 2027-01-05

  const hyd = getModelPricing('Gemini 4 Hydrogen (XHigh)', preDec);
  assert.equal(hyd.inputPer1M, 1.5);
  assert.equal(hyd.cacheReadPer1M, 0.075);
  assert.equal(hyd.outputPer1M, 7.5);
  assert.equal(hyd.exact, true);
  assert.equal(hyd.unknown, false);

  // Hydrogen (Orchestrator) 必须优先命中 Hydrogen 而非通用 Orchestrator (Carbon)
  const hydOrch = getModelPricing('Gemini 4 Hydrogen (Orchestrator)', preDec);
  assert.equal(hydOrch.family, 'Gemini 4 Hydrogen');
  assert.equal(hydOrch.inputPer1M, 1.5);

  // Orchestrator (Carbon) 与原始 ID gemini-pro-orchestrator 必须精准命中 Gemini 4 Carbon
  const orchCarb = getModelPricing('Orchestrator (Carbon)', preDec);
  assert.equal(orchCarb.family, 'Gemini 4 Carbon');
  assert.equal(orchCarb.inputPer1M, 2.0);
  const orchRaw = getModelPricing('gemini-pro-orchestrator', postDec);
  assert.equal(orchRaw.family, 'Gemini 4 Carbon');
  assert.equal(orchRaw.inputPer1M, 4.0);

  const argPre = getModelPricing('Gemini 4 Argon (High)', preDec);
  assert.equal(argPre.inputPer1M, 2.0);
  const argPost = getModelPricing('gemini-pro-orchestrator-argon', postDec);
  assert.equal(argPost.family, 'Gemini 4 Argon');
  assert.equal(argPost.inputPer1M, 4.0);

  const neon = getModelPricing('gemini-pro-orchestrator-neon', preDec);
  assert.equal(neon.family, 'Gemini 4 Neon');
  assert.equal(neon.inputPer1M, 3.0);
  assert.equal(neon.outputPer1M, 15.0);

  // 连字符模型 ID（如 claude-opus-5-5-high / claude-sonnet-5-5-medium）必须与小数点展示名一致
  const opusDash = getModelPricing('claude-opus-5-5-high', preDec);
  assert.equal(opusDash.family, 'Claude Opus 5.5');
  assert.equal(opusDash.inputPer1M, 4.0);
  assert.equal(opusDash.cacheReadPer1M, 0.2);
  assert.equal(opusDash.outputPer1M, 20.0);

  const sonnetDash = getModelPricing('claude-sonnet-5-5-medium', preDec);
  assert.equal(sonnetDash.family, 'Claude Sonnet 5.5');
  assert.equal(sonnetDash.inputPer1M, 2.0);
  assert.equal(sonnetDash.outputPer1M, 10.0);

  const opus46 = getModelPricing('Claude Opus 4.6', preDec);
  assert.equal(opus46.inputPer1M, 5.0);
  assert.equal(opus46.outputPer1M, 25.0);

  const opus41 = getModelPricing('claude-opus-4-1-20250805', preDec);
  assert.equal(opus41.inputPer1M, 15.0);
  assert.equal(opus41.outputPer1M, 75.0);

  const haiku45 = getModelPricing('claude-haiku-4-5', preDec);
  assert.equal(haiku45.family, 'Claude Haiku 4.5');
  assert.equal(haiku45.inputPer1M, 1.0);

  // Gemini 2.5 / 3.x Pro / Flash / Flash-Lite
  const f35 = getModelPricing('Gemini 3.5 Flash', preDec);
  assert.equal(f35.inputPer1M, 1.5);
  assert.equal(f35.outputPer1M, 9.0);

  const fl25 = getModelPricing('gemini-2.5-flash-lite', preDec);
  assert.equal(fl25.family, 'Gemini 2.5 Flash-Lite');
  assert.equal(fl25.inputPer1M, 0.1);

  const p25 = getModelPricing('Gemini 2.5 Pro', preDec);
  assert.equal(p25.family, 'Gemini 2.5 Pro');
  assert.equal(p25.inputPer1M, 1.25);
  assert.equal(p25.outputPer1M, 10.0);

  const p31 = getModelPricing('gemini-3.1-pro-preview', preDec);
  assert.equal(p31.family, 'Gemini 3 Pro');
  assert.equal(p31.inputPer1M, 2.0);
  assert.equal(p31.outputPer1M, 12.0);

  const f38Pre = getModelPricing('gemini-3.8-flash-tiered', preDec);
  assert.equal(f38Pre.inputPer1M, 0.75);
  const f38Post = getModelPricing('Gemini 3.8 Flash (High)', postJan);
  assert.equal(f38Post.inputPer1M, 1.5);

  // GPT-OSS 与 OpenAI GPT / o 系列细分
  const gptOss = getModelPricing('GPT-OSS 120B (Medium)', preDec);
  assert.equal(gptOss.family, 'GPT-OSS 120B');
  assert.equal(gptOss.inputPer1M, 0.15);
  assert.equal(gptOss.outputPer1M, 0.6);

  const gpt4oMini = getModelPricing('gpt-4o-mini', preDec);
  assert.equal(gpt4oMini.inputPer1M, 0.15);
  const gpt4o = getModelPricing('gpt-4o', preDec);
  assert.equal(gpt4o.inputPer1M, 2.5);
  const o3Mini = getModelPricing('o3-mini', preDec);
  assert.equal(o3Mini.inputPer1M, 1.1);
  const o3 = getModelPricing('o3', preDec);
  assert.equal(o3.inputPer1M, 2.0);

  // 未知模型显式标记 unknown: true
  const unk = getModelPricing('mystery-custom-model-v9', preDec);
  assert.equal(unk.exact, false);
  assert.equal(unk.unknown, true);

  // 基础单价核算：1M uncached input ($1.50) + 10M cache read ($0.75) + 1M output ($7.50) = $9.75
  const res = computeTokenCost({
    model: 'Gemini 4 Hydrogen (XHigh)',
    inputTokens: 1_000_000,
    cacheReadTokens: 10_000_000,
    outputTokens: 1_000_000,
  }, preDec);
  assert.equal(res.costUsd, 9.75);
  assert.equal(res.cacheSavingsUsd, 14.25);
});

test('>200k 长上下文阶梯单价在单步超阈值时精准翻倍，且多轮累计未超单步阈值时不误翻倍', () => {
  const preDec = Date.UTC(2026, 10, 20);
  assert.equal(LONG_CONTEXT_THRESHOLD_TOKENS, 200_000);

  // 恰好 200,000 tokens 仍属标准档（不翻倍）
  const at200k = computeTokenCost({
    model: 'Gemini 3.1 Pro',
    inputTokens: 200_000,
    outputTokens: 10_000,
    promptTokens: 200_000,
  }, preDec);
  assert.equal(at200k.pricing.longContextApplied, false);
  assert.equal(at200k.costUsd, 0.52); // 0.2M * $2 + 0.01M * $12 = 0.40 + 0.12

  // 250,000 tokens（50k uncached + 200k cacheRead > 200k）触发 >200k 阶梯（Input 2x=$4, Cache 2x=$0.4, Output 1.5x=$18）
  const over200k = computeTokenCost({
    model: 'Gemini 3.1 Pro',
    inputTokens: 50_000,
    cacheReadTokens: 200_000,
    outputTokens: 10_000,
    promptTokens: 250_000,
  }, preDec);
  assert.equal(over200k.pricing.longContextApplied, true);
  assert.equal(over200k.costUsd, 0.46); // 0.05*$4 + 0.2*$0.4 + 0.01*$18 = 0.20 + 0.08 + 0.18

  // Claude Sonnet 4.6 超 200k：$3/$15 -> $6/$22.5
  const claudeLong = getModelPricing('Claude Sonnet 4.6', preDec, { promptTokens: 210_000 });
  assert.equal(claudeLong.longContextApplied, true);
  assert.equal(claudeLong.inputPer1M, 6.0);
  assert.equal(claudeLong.outputPer1M, 22.5);

  // Flash / Haiku 等无阶梯模型超 200k 保持原单价
  const flashLong = computeTokenCost({
    model: 'Gemini 3.8 Flash (High)',
    inputTokens: 300_000,
    outputTokens: 0,
    promptTokens: 300_000,
  }, preDec);
  assert.equal(flashLong.pricing.longContextApplied, false);
  assert.equal(flashLong.costUsd, 0.225);

  // 多轮聚合桶（10 次请求合计 1.5M tokens，单次均值 150k <= 200k）绝不误触发 >200k 翻倍
  const multiReqNormal = computeTokenCost({
    model: 'Gemini 4 Argon (High)',
    inputTokens: 1_500_000,
    cacheReadTokens: 0,
    outputTokens: 0,
    requests: 10,
  }, preDec);
  assert.equal(multiReqNormal.pricing.longContextApplied, false);
  assert.equal(multiReqNormal.costUsd, 3.0);
});

test('多模型混合对话按每笔模型逐笔计费，且 12 月后查看 11 月历史账单全维度（日/模型/总计）均不追溯翻倍', async () => {
  // 1. 短上下文混合对话（每步 100k <= 200k）：0.1M * $0.75 ($0.075) + 0.1M * $4.00 ($0.40) = $0.475
  const mixedShort = computeConversationTelemetry({
    cascadeId: '33333333-3333-3333-3333-333333333333',
    generatorMetadata: [
      {
        stepIndices: [1],
        chatModel: {
          modelDisplayName: 'Gemini 3.8 Flash (High)',
          requestTime: '2026-11-19T10:00:00Z',
          usage: { inputTokens: '100000', outputTokens: '0', responseId: 'm-1' },
        },
      },
      {
        stepIndices: [2],
        chatModel: {
          modelDisplayName: 'Claude Opus 5.5 (High)',
          requestTime: '2026-11-19T10:05:00Z',
          usage: { inputTokens: '100000', outputTokens: '0', responseId: 'm-2' },
        },
      },
    ],
  });
  assert.equal(mixedShort.costUsd, 0.475);

  // 2. 单步超 200k 混合对话：1M Flash ($0.75，扁平价) + 1M Opus 5.5 (>200k 阶梯价 $8.00) = $8.75
  const mixedLong = computeConversationTelemetry({
    cascadeId: '44444444-4444-4444-4444-444444444444',
    generatorMetadata: [
      {
        stepIndices: [1],
        chatModel: {
          modelDisplayName: 'Gemini 3.8 Flash (High)',
          requestTime: '2026-11-19T10:00:00Z',
          usage: { inputTokens: '1000000', outputTokens: '0', responseId: 'L-1' },
        },
      },
      {
        stepIndices: [2],
        chatModel: {
          modelDisplayName: 'Claude Opus 5.5 (High)',
          requestTime: '2026-11-19T10:05:00Z',
          usage: { inputTokens: '1000000', outputTokens: '0', responseId: 'L-2' },
        },
      },
    ],
  });
  assert.equal(mixedLong.costUsd, 8.75);

  // 3. 11 月写入 10 笔各 100k（合计 1M，单步 <=200k，总额 $2.00），在 12 月调价后查看快照：日桶、模型榜与累计总计均锁定 $2.00
  const ledger = new UsageLedger(null);
  for (let i = 0; i < 10; i++) {
    await ledger.ingest([
      { id: `nov-${i}`, timestamp: '2026-11-19T12:00:00Z', model: 'Gemini 4 Argon (High)', inputTokens: 100_000, cacheReadTokens: 0, outputTokens: 0 },
    ]);
  }
  const snapDec = await ledger.snapshot(new Date('2026-12-05T12:00:00Z'));
  const novDay = snapDec.days.find((d) => d.date === '2026-11-19');
  assert.equal(novDay.costUsd, 2);
  assert.equal(snapDec.totalCostUsd, 2);
  assert.equal(snapDec.modelRank[0].costUsd, 2);
  // 同时 modelRank[0].pricing 展示 12 月当前实时牌价 $4.00
  assert.equal(snapDec.modelRank[0].pricing.inputPer1M, 4);
});

test('小额消费精度不截断归零，且异常输入或零折扣模型绝不产生 -0.00 或负数省钱额', () => {
  // $0.0015 微小花费完整保留
  const tiny = computeTokenCost({
    model: 'Gemini 4 Hydrogen',
    inputTokens: 1000,
    cacheReadTokens: 0,
    outputTokens: 0,
  });
  assert.equal(tiny.costUsd, 0.0015);
  assert.equal(tiny.cacheSavingsUsd, 0);
  assert.equal(Object.is(tiny.cacheSavingsUsd, -0), false);

  // 单 Token 极微花费（1 token * $0.075/1M = 7.5e-8 USD）也不被截断为 0
  const singleTok = computeTokenCost({
    model: 'Gemini 4 Hydrogen',
    inputTokens: 0,
    cacheReadTokens: 1,
    outputTokens: 0,
  });
  assert.equal(singleTok.costUsd, 7.5e-8);
  assert.ok(singleTok.costUsd > 0);

  // 无缓存折扣模型（cacheReadPer1M === inputPer1M）或负异常输入绝不产生 -0
  const noDiscount = computeTokenCost({
    model: 'o3-pro',
    inputTokens: -500,
    cacheReadTokens: 10_000,
    outputTokens: -10,
  });
  assert.equal(noDiscount.cacheSavingsUsd, 0);
  assert.equal(Object.is(noDiscount.cacheSavingsUsd, -0), false);
  assert.equal(Object.is(roundUsd(-0), -0), false);
  assert.equal(roundUsd(-0.0001), 0);
});
