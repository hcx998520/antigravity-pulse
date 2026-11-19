import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDurationSeconds,
  parseTokenCount,
  inferQuotaWindowKind,
  computeQuotaPacing,
  projectQuotaSummary,
  selectQuotaPair,
  projectUserStatus,
  computeConversationTelemetry,
} from '../src/telemetry.mjs';

test('computeQuotaPacing 精准计算时间基准刻度与消耗节奏（充裕 / 偏快 / 过快）', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  // 5h 窗口还剩 2.5h（50% 时间），额度还剩 80% -> ok
  const pOk = computeQuotaPacing(0.8, '2026-11-19T14:30:00Z', '5h', now);
  assert.equal(pOk.timeRemainingFraction, 0.5);
  assert.equal(pOk.status, 'ok');
  // 5h 窗口还剩 4h（80% 时间），额度仅剩 65% -> delta -0.15 -> fast
  const pFast = computeQuotaPacing(0.65, '2026-11-19T16:00:00Z', '5h', now);
  assert.equal(pFast.status, 'fast');
  // 周窗口还剩 6 天（~85.7% 时间），额度已跌至 35% -> burn
  const pBurn = computeQuotaPacing(0.35, '2026-11-25T12:00:00Z', 'week', now);
  assert.equal(pBurn.status, 'burn');
});

test('inferQuotaWindowKind 正确区分 5h 与周额度并在异常/过期时间下回退为 null', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  assert.equal(inferQuotaWindowKind('2026-11-19T16:12:00Z', now), '5h');
  assert.equal(inferQuotaWindowKind('2026-11-24T01:00:00Z', now), 'week');
  assert.equal(inferQuotaWindowKind('2026-11-19T11:00:00Z', now), null);
  assert.equal(inferQuotaWindowKind('2026-12-31T00:00:00Z', now), null);
  assert.equal(inferQuotaWindowKind(null, now), null);
});

test('projectQuotaSummary 与 selectQuotaPair 精准产出左 5h / 右周额度并优先匹配当前模型', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const summary = {
    response: {
      groups: [
        {
          displayName: 'Gemini 4 Neon',
          buckets: [
            { displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.97, resetTime: '2026-11-19T16:12:00Z' },
            { displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.82, resetTime: '2026-11-24T01:00:00Z' },
          ],
        },
        {
          displayName: 'Gemini 4 Carbon',
          buckets: [
            { displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.50, resetTime: '2026-11-19T15:00:00Z' },
            { displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.65, resetTime: '2026-11-24T01:00:00Z' },
          ],
        },
      ],
    },
  };
  const groups = projectQuotaSummary(summary, now);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].fiveHour.remainingFraction, 0.97);
  assert.equal(groups[0].weekly.remainingFraction, 0.82);

  const pairCarbon = selectQuotaPair(groups, 'Gemini 4 Carbon (High)');
  assert.equal(pairCarbon.fiveHourFraction, 0.5);
  assert.equal(pairCarbon.weeklyFraction, 0.65);

  const pairDefault = selectQuotaPair(groups, null);
  assert.equal(pairDefault.fiveHourFraction, 0.97);
  assert.equal(pairDefault.weeklyFraction, 0.82);
});

test('parseDurationSeconds 与 parseTokenCount 严格拒绝布尔、数组、空白与越界值', () => {
  assert.equal(parseDurationSeconds('6.25s'), 6.25);
  assert.equal(parseDurationSeconds({ seconds: 2, nanos: 500000000 }), 2.5);
  assert.equal(parseDurationSeconds({ seconds: 1, nanos: 2_000_000_000 }), null);
  assert.equal(parseTokenCount('123'), 123);
  assert.equal(parseTokenCount(true), null);
  assert.equal(parseTokenCount('   '), null);
  assert.equal(parseTokenCount([]), null);
  assert.equal(parseTokenCount(Infinity), null);
});

test('projectUserStatus 立即剔除邮箱等敏感字段；computeConversationTelemetry 先去重再汇总且不泄露原始 ID', () => {
  const proj = projectUserStatus({
    email: 'secret@example.com',
    cascadeModelConfigData: {
      clientModelConfigs: [
        { label: 'Gemini 4 Neon (High)', modelOrAlias: { model: 'MODEL_M532' }, quotaInfo: { remainingFraction: 0.85, resetTime: '2026-11-19T12:00:00Z' } },
      ],
    },
  });
  assert.equal(JSON.stringify(proj.quotas).includes('secret@example.com'), false);

  const result = computeConversationTelemetry({
    cascadeId: '11111111-1111-1111-1111-111111111111',
    status: 'CASCADE_RUN_STATUS_RUNNING',
    modelLabelMap: proj.labelMap,
    generatorMetadata: [
      {
        stepIndices: [1, 2],
        chatModel: {
          model: 'MODEL_M532',
          systemPrompt: 'SENSITIVE_PROMPT_MUST_NOT_LEAK',
          timeToFirstToken: '2.5s',
          streamingDuration: '10.0s',
          chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 50000, maxContextTokens: 500000 } },
          usage: { inputTokens: '1000', cacheReadTokens: '9000', outputTokens: '1500', thinkingOutputTokens: '1000', responseOutputTokens: '500', responseId: 'raw-secret-resp-1' },
        },
      },
      // 同 responseId 重复出现时只计一次（最终快照覆盖），UI 与账本口径一致
      {
        stepIndices: [1, 2],
        chatModel: {
          model: 'MODEL_M532',
          timeToFirstToken: '2.5s',
          streamingDuration: '10.0s',
          usage: { inputTokens: '1000', cacheReadTokens: '9000', outputTokens: '1500', thinkingOutputTokens: '1000', responseOutputTokens: '500', responseId: 'raw-secret-resp-1' },
        },
      },
      {
        stepIndices: [3],
        chatModel: {
          model: 'MODEL_M532',
          timeToFirstToken: '1.0s',
          streamingDuration: '0.01s',
          usage: { inputTokens: '200', cacheReadTokens: '800', outputTokens: '100', responseId: 'raw-resp-glitch' },
        },
      },
    ],
  });

  assert.equal(result.model, 'Gemini 4 Neon (High)');
  assert.equal(result.tps, 150);
  assert.equal(result.latestTps, 150);
  assert.equal(result.excludedOutliers, 1);
  assert.equal(result.requests, 2);
  assert.equal(result.tokens.output, 1600);
  assert.equal(JSON.stringify(result).includes('SENSITIVE_PROMPT'), false);
  // 账本去重 ID 已单向哈希，不含原始 responseId
  assert.equal(result.ledgerEvents.some((e) => e.id.includes('raw-secret-resp-1')), false);
});

test('selectQuotaPair 支持按模型家族匹配官方分组且不跨组借用缺失侧；上下文满窗与 thinkingRatio 边界准确', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const groups = projectQuotaSummary({
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { displayName: '5h', window: '5h', remainingFraction: 0.95, resetTime: '2026-11-19T16:00:00Z' },
            { displayName: 'Weekly', window: 'weekly', remainingFraction: 0.91, resetTime: '2026-11-24T12:00:00Z' },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { displayName: '5h', window: '5h', remainingFraction: 0.11, resetTime: '2026-11-19T13:30:00Z' },
          ],
        },
      ],
    },
  }, now);

  // 切到 Claude 对话必须精准选中 Claude and GPT models，且该组无周额度时绝不借用 Gemini 的 91%
  const claudePair = selectQuotaPair(groups, 'Claude Opus 5.5 (High)');
  assert.equal(claudePair.title, 'Claude and GPT models');
  assert.equal(claudePair.fiveHourFraction, 0.11);
  assert.equal(claudePair.weeklyFraction, null);

  const geminiPair = selectQuotaPair(groups, 'Gemini 4 Neon (High)');
  assert.equal(geminiPair.title, 'Gemini Models');
  assert.equal(geminiPair.fiveHourFraction, 0.95);
  assert.equal(geminiPair.weeklyFraction, 0.91);

  // 上下文 100% 满窗 -> estimatedTurnsLeft === 0；thinkingRatio 钳制 <= 1；切模型后 model 取最新请求
  const fullCtx = computeConversationTelemetry({
    cascadeId: '22222222-2222-2222-2222-222222222222',
    generatorMetadata: [
      {
        stepIndices: [1],
        chatModel: {
          modelDisplayName: 'Gemini 4 Neon (High)',
          streamingDuration: '2.0s',
          usage: { inputTokens: '1000', outputTokens: '200', thinkingOutputTokens: '300', responseId: 'r1' },
        },
      },
      {
        stepIndices: [2],
        chatModel: {
          modelDisplayName: 'Claude Opus 5.5 (High)',
          chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 512000, maxContextTokens: 512000 } },
          usage: { inputTokens: '2000', outputTokens: '100', responseId: 'r2' },
        },
      },
    ],
  });
  assert.equal(fullCtx.model, 'Claude Opus 5.5 (High)');
  assert.equal(fullCtx.context.estimatedTurnsLeft, 0);
  assert.equal(fullCtx.thinkingRatio, 1);
});

test('Protobuf3 省略 0% remainingFraction 或刚重置缺 resetTime 的周额度桶绝不丢失', () => {
  const now = Date.parse('2026-11-20T02:00:00Z');
  const groups = projectQuotaSummary({
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { displayName: '5h', window: '5h', remainingFraction: 0.89, resetTime: '2026-11-20T06:00:00Z' },
            // 周额度耗尽至 0% 时 Protobuf3 JSON 省略 remainingFraction，仅保留 resetTime
            { displayName: 'Weekly Limit', resetTime: '2026-11-26T00:00:00Z' },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { displayName: '5h', remainingFraction: 0.92, resetTime: '2026-11-20T05:30:00Z' },
            // 周额度刚重置满血无 resetTime 且无关键词时，双桶自动补位为周额度
            { displayName: 'Secondary Bucket', remainingFraction: 1 },
          ],
        },
      ],
    },
  }, now);

  const gPair = selectQuotaPair(groups, 'Gemini 4 Neon (High)');
  assert.equal(gPair.fiveHourFraction, 0.89);
  assert.equal(gPair.weeklyFraction, 0);

  const cPair = selectQuotaPair(groups, 'Claude Opus 5.5 (High)');
  assert.equal(cPair.fiveHourFraction, 0.92);
  assert.equal(cPair.weeklyFraction, 1);
});
