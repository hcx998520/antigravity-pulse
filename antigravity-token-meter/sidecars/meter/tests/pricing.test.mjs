import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTokenCost, getModelPricing } from '../src/pricing.mjs';
import { computeConversationTelemetry } from '../src/telemetry.mjs';
import { UsageLedger } from '../src/ledger.mjs';

test('getModelPricing 与 computeTokenCost 精准匹配 Gemini 3.5 Flash / 3.8 Flash / Hydrogen / Argon / Carbon / Neon 与 Claude 定价', () => {
  const preDec = Date.UTC(2026, 10, 19); // 2026-11-19
  const postDec = Date.UTC(2026, 11, 2); // 2026-12-02

  const hyd = getModelPricing('Gemini 4 Hydrogen (XHigh)', preDec);
  assert.equal(hyd.inputPer1M, 1.5);
  assert.equal(hyd.cacheReadPer1M, 0.075);
  assert.equal(hyd.outputPer1M, 7.5);

  const argPre = getModelPricing('Gemini 4 Argon (High)', preDec);
  assert.equal(argPre.inputPer1M, 2.0);
  const argPost = getModelPricing('Gemini 4 Argon (High)', postDec);
  assert.equal(argPost.inputPer1M, 4.0);

  const carb = getModelPricing('gemini-4-carbon', preDec);
  assert.equal(carb.outputPer1M, 10.0);

  const neon = getModelPricing('Gemini 4 Neon', preDec);
  assert.equal(neon.inputPer1M, 3.0);
  assert.equal(neon.outputPer1M, 15.0);

  const f35 = getModelPricing('Gemini 3.5 Flash', preDec);
  assert.equal(f35.inputPer1M, 1.5);
  assert.equal(f35.cacheReadPer1M, 0.15);
  assert.equal(f35.outputPer1M, 9.0);

  const f38 = getModelPricing('Gemini 3.8 Flash (High)', preDec);
  assert.equal(f38.inputPer1M, 0.75);
  assert.equal(f38.cacheReadPer1M, 0.075);
  assert.equal(f38.outputPer1M, 3.75);

  // 1M uncached input ($1.50) + 10M cache read ($0.75) + 1M output ($7.50) = $9.75
  const res = computeTokenCost({
    model: 'Gemini 4 Hydrogen (XHigh)',
    inputTokens: 1_000_000,
    cacheReadTokens: 10_000_000,
    outputTokens: 1_000_000,
  }, preDec);
  assert.equal(res.costUsd, 9.75);
  assert.equal(res.cacheSavingsUsd, 14.25);
});

test('多模型混合对话按每笔模型逐笔计费，且 12 月后查看 11 月历史账单不追溯翻倍', async () => {
  const mixed = computeConversationTelemetry({
    cascadeId: '33333333-3333-3333-3333-333333333333',
    generatorMetadata: [
      {
        stepIndices: [1],
        chatModel: {
          modelDisplayName: 'Gemini 3.8 Flash (High)',
          requestTime: '2026-11-19T10:00:00Z',
          usage: { inputTokens: '1000000', outputTokens: '0', responseId: 'm-1' }, // $0.75
        },
      },
      {
        stepIndices: [2],
        chatModel: {
          modelDisplayName: 'Claude Opus 5.5 (High)',
          requestTime: '2026-11-19T10:05:00Z',
          usage: { inputTokens: '1000000', outputTokens: '0', responseId: 'm-2' }, // $4.00
        },
      },
    ],
  });
  // 应精确等于 0.75 + 4.00 = 4.75，而不是把全部 2M 都按 Opus 算成 8.00
  assert.equal(mixed.costUsd, 4.75);

  const ledger = new UsageLedger(null);
  await ledger.ingest([
    { id: 'nov-1', timestamp: '2026-11-19T12:00:00Z', model: 'Gemini 4 Argon (High)', inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 },
  ]);
  // 在 2026-12-05 查看 11-19 历史日桶，仍应按 11 月当时费率 $2.00 计算而非被 12 月新价 $4.00 追溯翻倍
  const snapDec = await ledger.snapshot(new Date('2026-12-05T12:00:00Z'));
  const novDay = snapDec.days.find((d) => d.date === '2026-11-19');
  assert.equal(novDay.costUsd, 2);
});
