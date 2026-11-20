import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UsageLedger, toLocalDateKey } from '../src/ledger.mjs';
import { roundUsd } from '../src/pricing.mjs';

test('UsageLedger 并发 ingest 不丢写、支持差值 upsert、防 __proto__ 原型污染并保留损坏文件', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-ledger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger-v1.json');
  const nowIso = new Date().toISOString();

  const ledger = new UsageLedger(file);
  // 并发写入 + 增量更新同一事件 ID + 恶意 __proto__ 模型名
  await Promise.all([
    ledger.ingest([{ id: 'e1', timestamp: nowIso, model: 'Gemini 4 Neon', inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 200, streamingSeconds: 2, timedOutputTokens: 200 }]),
    ledger.ingest([{ id: 'e2', timestamp: nowIso, model: '__proto__', inputTokens: 100, cacheReadTokens: 0, outputTokens: 50, streamingSeconds: 1, timedOutputTokens: 50 }]),
  ]);
  // 同一请求 e1 后续完成输出增长到 600 tokens，应按差值 +400 补记而非忽略或双倍计算
  await ledger.ingest([{ id: 'e1', timestamp: nowIso, model: 'Gemini 4 Neon', inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 600, streamingSeconds: 4, timedOutputTokens: 600 }]);
  await ledger.flush();

  // 确认未污染 Object.prototype
  assert.equal(({}).total, undefined);

  const reloaded = new UsageLedger(file);
  const snap = await reloaded.snapshot(new Date(nowIso));
  assert.equal(snap.todayTokens, 3750);
  assert.equal(snap.todayInput, 1100);
  assert.equal(snap.todayCacheRead, 2000);
  assert.equal(snap.todayOutput, 650);
  assert.equal(snap.todayByModel[0].model, 'Gemini 4 Neon');
  assert.equal(snap.todayByModel[0].totalTokens, 3600);
  assert.equal(snap.totalTokens, 3750);
  assert.equal(snap.todayRequests, 2);
  // 小额花费（~$0.0113）不被 toFixed(4) 抹零且全维度严格对账相等
  assert.ok(snap.todayCostUsd > 0.01);
  assert.equal(snap.todayCostUsd, snap.totalCostUsd);
  assert.equal(snap.todayCostUsd, roundUsd(snap.todayByModel.reduce((s, m) => s + m.costUsd, 0)));
  assert.equal(snap.totalCostUsd, roundUsd(snap.modelRank.reduce((s, m) => s + m.costUsd, 0)));

  const neon = snap.modelRank.find((m) => m.model === 'Gemini 4 Neon');
  assert.equal(neon.avgTps, 150);

  // 损坏账本保留原文件不静默覆盖
  const brokenFile = join(dir, 'broken.json');
  await writeFile(brokenFile, '{corrupted-json', 'utf8');
  const brokenLedger = new UsageLedger(brokenFile);
  await brokenLedger.ingest([{ id: 'x1', timestamp: nowIso, model: 'M', inputTokens: 10, cacheReadTokens: 0, outputTokens: 5 }]);
  assert.equal(brokenLedger.corrupted, true);
  assert.equal(await readFile(brokenFile, 'utf8'), '{corrupted-json');
});

test('UsageLedger 支持聚合历史导入、重叠替换、幂等防重与 pending-import.json 自动吸纳', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-ledger-import-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger-v1.json');

  // 预先模拟用户当天试跑记入了一笔重叠数据，以及次日一笔全新数据
  const seed = new UsageLedger(file);
  await seed.ingest([
    { id: 'overlap-1', timestamp: '2026-11-19T14:40:00.000Z', model: 'Gemini 4 Neon', inputTokens: 500, cacheReadTokens: 500, outputTokens: 100 },
    { id: 'future-1', timestamp: '2026-11-20T01:00:00.000Z', model: 'Gemini 4 Neon', inputTokens: 200, cacheReadTokens: 300, outputTokens: 50 },
  ]);

  // 写入 pending-import.json 模拟 sidecar 运行中落盘保护队列
  const bundle = {
    schema: 1,
    batchId: 'legacy-usage-v1-testbatch',
    source: 'legacy-usage-v1',
    importedUntil: '2026-11-19T14:33:04.257Z',
    replaceOverlappingBeforeCutoff: true,
    lifetimeTotal: 150000,
    days: {
      '2026-10-15': { total: 50000, input: 10000, cacheRead: 35000, output: 5000, requests: 12, byModel: { 'Gemini 4 Argon': 50000 } },
      '2026-11-19': { total: 100000, input: 20000, cacheRead: 70000, output: 10000, requests: 30, byModel: { 'Gemini 4 Argon': 100000 } },
    },
    models: {
      'Gemini 4 Argon': { total: 150000, input: 30000, cacheRead: 105000, output: 15000, thinking: 3000, requests: 42, timedOutput: 0, streamingSec: 0 },
    },
  };
  await writeFile(join(dir, 'pending-import.json'), JSON.stringify(bundle), 'utf8');

  // readOnly 模式不得消费 pending-import.json
  const roLedger = new UsageLedger(file, { readOnly: true });
  const roSnap = await roLedger.snapshot(new Date('2026-11-20T02:00:00.000Z'));
  assert.equal(roSnap.totalTokens, 1650);

  // 正常读写实例启动 load 自动吸纳 pending-import.json 并原子归档
  const live = new UsageLedger(file);
  const snap = await live.snapshot(new Date('2026-11-20T02:00:00.000Z'));
  // 2026-11-19 试跑重叠 1100 被干净替换为旧账本 100000，2026-11-20 新数据 550 完整保留 -> 累计 150550
  assert.equal(snap.totalTokens, 150550);
  assert.equal(snap.monthTokens, 100550);
  assert.equal(snap.monthRequests, 31);
  assert.equal(snap.activeDays, 3);
  assert.equal(snap.peakDay.date, '2026-11-19');
  assert.equal(snap.peakDay.total, 100000);
  assert.equal(snap.currentStreak, 2);
  assert.equal(snap.longestStreak, 2);
  assert.equal(snap.days[snap.days.length - 2].byModel['Gemini 4 Argon'], 100000);
  assert.equal(snap.importedUntil, '2026-11-19T14:33:04.257Z');
  assert.equal(await live.getImportedUntilMs(), Date.parse('2026-11-19T14:33:04.257Z'));

  // 导入合并后按日费用加总与按模型费用加总依然 100% 闭合对账
  const sumDays = roundUsd(snap.days.reduce((s, d) => s + d.costUsd, 0));
  const sumModels = roundUsd(snap.modelRank.reduce((s, m) => s + m.costUsd, 0));
  assert.equal(snap.totalCostUsd, sumDays);
  assert.equal(snap.totalCostUsd, sumModels);

  // 重复应用同一 batchId 必须幂等跳过
  const dup = await live.applyImportBundle(bundle);
  assert.equal(dup.applied, false);
  assert.equal(dup.reason, 'already_applied');

  // 重叠替换保留的次日记录 future-1 再次被轮询 ingest 时必须去重不翻倍，且 models 明细（requests/output）完整保留
  await live.ingest([
    { id: 'future-1', timestamp: '2026-11-20T01:00:00.000Z', model: 'Gemini 4 Neon', inputTokens: 200, cacheReadTokens: 300, outputTokens: 50 },
  ]);
  const afterReplay = await live.snapshot(new Date('2026-11-20T02:00:00.000Z'));
  assert.equal(afterReplay.totalTokens, 150550);
  const neonRank = afterReplay.modelRank.find((m) => m.model === 'Gemini 4 Neon');
  assert.equal(neonRank.requests, 1);
  assert.equal(neonRank.outputTokens, 50);

  // 损坏账本调用 applyImportBundle 必须显式拒绝，不得谎报成功
  const badPath = join(dir, 'corrupted-import.json');
  await writeFile(badPath, '{not-json', 'utf8');
  const badLedger = new UsageLedger(badPath);
  const badRes = await badLedger.applyImportBundle(bundle);
  assert.equal(badRes.applied, false);
  assert.equal(badRes.reason, 'corrupted_ledger');
});

test('同日混用高低价模型、跨 >200k 阶梯流式更新及旧版无明细账本水合均 100% 严丝合缝对账', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-ledger-reconcile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger-v1.json');

  const ledger = new UsageLedger(file);
  // 同日混用极低价缓存模型（Claude Haiku 5.5 全缓存读取）与极高价输出模型（Claude Fable 5.1 全无缓存输入+输出）
  // 并且模拟一笔从 150k 增长到 250k（跨越 >200k 阶梯阈值）的流式请求
  await ledger.ingest([
    { id: 'haiku-cache', timestamp: '2026-11-20T04:00:00Z', model: 'Claude Haiku 5.5', inputTokens: 0, cacheReadTokens: 100_000, outputTokens: 1_000 }, // 0.1*$0.01 + 0.001*$0.5 = $0.0015
    { id: 'fable-heavy', timestamp: '2026-11-20T05:00:00Z', model: 'Claude Fable 5.1', inputTokens: 50_000, cacheReadTokens: 0, outputTokens: 20_000 },  // 0.05*$10 + 0.02*$50 = $1.50
    { id: 'stream-step', timestamp: '2026-11-20T06:00:00Z', model: 'Gemini 3.1 Pro', inputTokens: 150_000, cacheReadTokens: 0, outputTokens: 1_000 },     // 先 <=200k
  ]);
  // 流式最终态跨越 200k 阈值（250k input + 10k output -> 0.25*$4 + 0.01*$18 = $1.18）
  await ledger.ingest([
    { id: 'stream-step', timestamp: '2026-11-20T06:00:00Z', model: 'Gemini 3.1 Pro', inputTokens: 250_000, cacheReadTokens: 0, outputTokens: 10_000 },
  ]);

  const snap = await ledger.snapshot(new Date('2026-11-20T08:00:00Z'));
  const expectedTotal = roundUsd(0.0015 + 1.5 + 1.18); // 2.6815
  assert.equal(snap.todayCostUsd, expectedTotal);
  assert.equal(snap.weekCostUsd, expectedTotal);
  assert.equal(snap.monthCostUsd, expectedTotal);
  assert.equal(snap.totalCostUsd, expectedTotal);
  assert.equal(roundUsd(snap.todayByModel.reduce((s, m) => s + m.costUsd, 0)), expectedTotal);
  assert.equal(roundUsd(snap.modelRank.reduce((s, m) => s + m.costUsd, 0)), expectedTotal);

  // 构造一份模拟旧版 schema:2 账本（超过 35 天、无 byModelDetail / costUsd 字段），验证向后兼容与全量天数对账
  const legacyPath = join(dir, 'legacy-schema2.json');
  const legacyDays = {};
  for (let i = 1; i <= 40; i++) {
    const dk = `2026-10-${String(Math.min(28, i)).padStart(2, '0')}`;
    const realKey = i <= 28 ? dk : `2026-11-${String(i - 28).padStart(2, '0')}`;
    legacyDays[realKey] = {
      total: 30_000,
      input: 10_000,
      cacheRead: 15_000,
      output: 5_000,
      requests: 3,
      byModel: {
        'gemini-4-argon': 20_000,
        'claude-opus-5-5-high': 10_000,
      },
    };
  }
  const legacyPayload = {
    schema: 2,
    lifetimeTotal: 40 * 30_000,
    importedUntil: null,
    evictedUntil: null,
    appliedImports: [],
    recordOrder: [],
    records: {},
    days: legacyDays,
    models: {
      'gemini-4-argon': { total: 40 * 20_000, input: 40 * 5_000, cacheRead: 40 * 12_000, output: 40 * 3_000, thinking: 0, requests: 80, timedOutput: 0, streamingSec: 0 },
      'claude-opus-5-5-high': { total: 40 * 10_000, input: 40 * 5_000, cacheRead: 40 * 3_000, output: 40 * 2_000, thinking: 0, requests: 40, timedOutput: 0, streamingSec: 0 },
    },
    updatedAt: '2026-11-12T12:00:00Z',
  };
  await writeFile(legacyPath, JSON.stringify(legacyPayload), 'utf8');

  const legacyLedger = new UsageLedger(legacyPath, { readOnly: true });
  const decSnap = await legacyLedger.snapshot(new Date('2026-12-15T12:00:00Z'));
  assert.equal(decSnap.days.length, 40);
  // 全部 40 天都必须保留完整 byModelCost（不因 >35 天截断丢失），且每日分模型费用之和严格等于当日总费用
  for (const d of decSnap.days) {
    assert.ok(d.byModelCost && Object.keys(d.byModelCost).length === 2);
    assert.equal(roundUsd(Object.values(d.byModelCost).reduce((a, b) => a + b, 0)), d.costUsd);
  }
  assert.equal(roundUsd(decSnap.days.reduce((s, d) => s + d.costUsd, 0)), decSnap.totalCostUsd);
  assert.equal(roundUsd(decSnap.modelRank.reduce((s, m) => s + m.costUsd, 0)), decSnap.totalCostUsd);

  // toLocalDateKey 对纯 YYYY-MM-DD 字符串绝不因 UTC 午夜解析而在西半球往前偏移一天
  assert.equal(toLocalDateKey('2026-11-20'), '2026-11-20');
});

test('含 unattributedTokens 余量的历史旧账本在 ingest 新事件落盘并二次实例化加载后对账 100% 闭合不漂移', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-ledger-unattrib-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger-v1.json');

  // 构造一天的 total (100,000) > sum(byModel) (70,000) 含 30,000 未归属余量的旧版 schema:2 账本
  const seedPayload = {
    schema: 2,
    lifetimeTotal: 100_000,
    importedUntil: null,
    evictedUntil: null,
    appliedImports: [],
    recordOrder: [],
    records: {},
    days: {
      '2026-11-10': {
        total: 100_000,
        input: 20_000,
        cacheRead: 70_000,
        output: 10_000,
        requests: 5,
        byModel: {
          'Claude Opus 5.5 (High)': 40_000,
          'Gemini 3.8 Flash (High)': 30_000,
        },
      },
    },
    models: {
      'Claude Opus 5.5 (High)': { total: 40_000, input: 5_000, cacheRead: 34_000, output: 1_000, thinking: 0, requests: 2, timedOutput: 0, streamingSec: 0 },
      'Gemini 3.8 Flash (High)': { total: 30_000, input: 10_000, cacheRead: 15_000, output: 5_000, thinking: 0, requests: 2, timedOutput: 0, streamingSec: 0 },
    },
    updatedAt: '2026-11-10T12:00:00Z',
  };
  await writeFile(file, JSON.stringify(seedPayload), 'utf8');

  // 第一次加载并 ingest 显著改变模型输入/输出比例的新请求，触发落盘持久化
  const firstInstance = new UsageLedger(file);
  await firstInstance.ingest([
    {
      id: 'new-heavy-out',
      timestamp: '2026-11-20T09:00:00Z',
      model: 'Claude Opus 5.5 (High)',
      inputTokens: 5_000,
      cacheReadTokens: 0,
      outputTokens: 25_000,
    },
  ]);
  const snap1 = await firstInstance.snapshot(new Date('2026-11-20T10:00:00Z'));
  assert.equal(roundUsd(snap1.days.reduce((s, d) => s + d.costUsd, 0)), snap1.totalCostUsd);

  // 重启创建第二个实例重新从磁盘 load：历史日桶必须保持已水合明细，绝不因新 modelPriors 重跑水合导致对账漂移
  const secondInstance = new UsageLedger(file);
  const snap2 = await secondInstance.snapshot(new Date('2026-11-20T10:00:00Z'));
  assert.equal(snap2.totalCostUsd, snap1.totalCostUsd);
  assert.equal(roundUsd(snap2.days.reduce((s, d) => s + d.costUsd, 0)), snap2.totalCostUsd);
  assert.equal(snap2.days[0].costUsd, snap1.days[0].costUsd);
});
