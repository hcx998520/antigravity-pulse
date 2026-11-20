#!/usr/bin/env node
/**
 * Antigravity TokenMeter 通用旧版用量历史导入工具（MIT License，零外部依赖）。
 *
 * 用途：
 * - 将旧版插件留在本机的 usage-v1 历史记录 JSON（按 id 去重）无损聚合迁移至 TokenMeter 账本；
 * - 写入前自动备份现有 ledger-v1.json；
 * - 通过 batchId + importedUntil 水位线实现 100% 幂等防重与防双倍记账；
 * - 若检测到 Antigravity sidecar 正在后台运行，额外写入 pending-import.json 保护队列，
 *   避免运行中的旧进程内存刷盘覆盖导入结果，重启 Antigravity 后自动原子吸纳并归档。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LEDGER_MODULE = resolve(SCRIPT_DIR, '..', 'antigravity-token-meter', 'sidecars', 'meter', 'src', 'ledger.mjs');
const { UsageLedger, toLocalDateKey } = await import(pathToFileURL(LEDGER_MODULE).href);

function safeInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(n)) : 0;
}

function fmtTokens(n) {
  const v = safeInt(n);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

function parseArgs(argv) {
  const opts = {
    source: join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'antigravity-pulse', 'panel', 'data', 'usage-v1'),
    target: join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'antigravity-token-meter', 'meter', 'data', 'ledger-v1.json'),
    dryRun: false,
    replaceOverlap: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--no-replace-overlap') {
      opts.replaceOverlap = false;
    } else if (arg === '--source' && argv[i + 1]) {
      opts.source = resolve(argv[++i]);
    } else if (arg === '--target' && argv[i + 1]) {
      opts.target = resolve(argv[++i]);
    }
  }
  return opts;
}

function parseTimestampMs(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : NaN;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return NaN;
    if (/^\d{10,15}$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : NaN;
    }
    const ms = Date.parse(s);
    return Number.isFinite(ms) && ms > 0 ? ms : NaN;
  }
  return NaN;
}

function printHelp() {
  console.log([
    'Antigravity TokenMeter 历史用量迁移工具 (v1.2.15)',
    '',
    '用法:',
    '  node scripts/import_legacy_usage.mjs [选项]',
    '',
    '选项:',
    '  --source <目录>         指定旧版 usage-v1 历史目录（默认自动定位本机数据目录）',
    '  --target <文件>         指定目标 ledger-v1.json 路径（默认自动定位 TokenMeter 账本）',
    '  --dry-run               仅预览扫描与统计结果，不写入磁盘',
    '  --no-replace-overlap    强制叠加模式，不替换首次导入截断日前的试运行重叠数据',
    '  -h, --help              显示帮助信息',
  ].join('\n'));
}

function walkJsonFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkJsonFiles(full, out);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function hasActiveOwnerLease(ledgerPath) {
  const leasePath = join(dirname(ledgerPath), 'owner-lease.json');
  if (!existsSync(leasePath)) return false;
  try {
    const raw = JSON.parse(readFileSync(leasePath, 'utf8'));
    const expiresAt = Number(raw?.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) return true;
    const heartbeatAt = Number(raw?.heartbeatAt);
    if (Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt < 20000) return true;
    if (Number.isInteger(raw?.pid) && isPidAlive(raw.pid)) return true;
    return false;
  } catch {
    return false;
  }
}

export function buildLegacyImportBundle(sourceDir, { replaceOverlap = true } = {}) {
  const files = walkJsonFiles(sourceDir);
  if (files.length === 0) {
    return { filesScanned: 0, recordCount: 0, bundle: null };
  }

  const deduped = new Map();
  let parseErrors = 0;

  for (const file of files) {
    try {
      const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.records)
        ? parsed.records
        : Array.isArray(parsed)
          ? parsed
          : [];
      for (const rec of list) {
        if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string' || !rec.id.trim()) continue;
        const atMs = parseTimestampMs(rec.at ?? rec.timestamp);
        if (!Number.isFinite(atMs) || atMs <= 0) continue;

        const input = safeInt(rec.uncached ?? rec.inputTokens) + safeInt(rec.cacheWrite ?? rec.cacheWriteTokens);
        const cacheRead = safeInt(rec.cacheRead ?? rec.cacheReadTokens);
        const output = safeInt(rec.output ?? rec.outputTokens);
        const thinking = safeInt(rec.thinking ?? rec.thinkingTokens);
        const total = input + cacheRead + output;
        if (total <= 0) continue;

        const id = rec.id.trim();
        const prev = deduped.get(id);
        if (!prev || total > prev.total) {
          deduped.set(id, {
            id,
            atMs,
            model: String(rec.model || 'Unknown').trim().slice(0, 128) || 'Unknown',
            input,
            cacheRead,
            output,
            thinking,
            total,
          });
        }
      }
    } catch {
      parseErrors++;
    }
  }

  if (deduped.size === 0) {
    return { filesScanned: files.length, parseErrors, recordCount: 0, bundle: null };
  }

  let minAtMs = Infinity;
  let maxAtMs = 0;
  let lifetimeTotal = 0;
  const days = Object.create(null);
  const models = Object.create(null);

  for (const rec of deduped.values()) {
    if (rec.atMs < minAtMs) minAtMs = rec.atMs;
    if (rec.atMs > maxAtMs) maxAtMs = rec.atMs;
    lifetimeTotal += rec.total;

    const dateKey = toLocalDateKey(new Date(rec.atMs));
    if (!Object.hasOwn(days, dateKey)) {
      days[dateKey] = {
        total: 0,
        input: 0,
        cacheRead: 0,
        output: 0,
        requests: 0,
        byModel: Object.create(null),
      };
    }
    const d = days[dateKey];
    d.total += rec.total;
    d.input += rec.input;
    d.cacheRead += rec.cacheRead;
    d.output += rec.output;
    d.requests += 1;
    d.byModel[rec.model] = (d.byModel[rec.model] || 0) + rec.total;

    if (!Object.hasOwn(models, rec.model)) {
      models[rec.model] = {
        total: 0,
        input: 0,
        cacheRead: 0,
        output: 0,
        thinking: 0,
        requests: 0,
        timedOutput: 0,
        streamingSec: 0,
      };
    }
    const m = models[rec.model];
    m.total += rec.total;
    m.input += rec.input;
    m.cacheRead += rec.cacheRead;
    m.output += rec.output;
    m.thinking += rec.thinking;
    m.requests += 1;
  }

  const fingerprint = createHash('sha256')
    .update(`legacy-usage-v1|${deduped.size}|${minAtMs}|${maxAtMs}|${lifetimeTotal}`)
    .digest('hex')
    .slice(0, 16);

  const bundle = {
    schema: 1,
    batchId: `legacy-usage-v1-${fingerprint}`,
    source: 'legacy-usage-v1',
    importedUntil: new Date(maxAtMs).toISOString(),
    replaceOverlappingBeforeCutoff: Boolean(replaceOverlap),
    lifetimeTotal,
    days,
    models,
  };

  return {
    filesScanned: files.length,
    parseErrors,
    recordCount: deduped.size,
    activeDays: Object.keys(days).length,
    minAtIso: new Date(minAtMs).toISOString(),
    maxAtIso: new Date(maxAtMs).toISOString(),
    bundle,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  if (!existsSync(opts.source)) {
    console.log(`[TokenMeter] 未找到旧版历史数据目录：${opts.source}`);
    console.log('[TokenMeter] 若旧数据位于其他目录，请通过 --source <目录> 指定。');
    process.exitCode = 1;
    return;
  }

  const scan = buildLegacyImportBundle(opts.source, { replaceOverlap: opts.replaceOverlap });
  if (!scan.bundle) {
    console.log(`[TokenMeter] 已扫描 ${scan.filesScanned} 个文件，但未发现可导入的有效记录。`);
    return;
  }

  const todayPrefix = toLocalDateKey(new Date()).slice(0, 7);
  let monthTokens = 0;
  let monthRequests = 0;
  for (const [k, d] of Object.entries(scan.bundle.days)) {
    if (k.startsWith(todayPrefix)) {
      monthTokens += d.total;
      monthRequests += d.requests;
    }
  }

  console.log('======================================================');
  console.log(' Antigravity TokenMeter 历史用量迁移预览');
  console.log('======================================================');
  console.log(` 扫描文件数   : ${scan.filesScanned}（异常跳过 ${scan.parseErrors}）`);
  console.log(` 去重请求笔数 : ${scan.recordCount.toLocaleString()}`);
  console.log(` 覆盖时间跨度 : ${scan.minAtIso} ~ ${scan.maxAtIso}`);
  console.log(` 活跃天数     : ${scan.activeDays} 天`);
  console.log(` 本月消耗 (${todayPrefix}) : ${fmtTokens(monthTokens)} (${monthRequests.toLocaleString()} 次请求)`);
  console.log(` 历史累计总量 : ${fmtTokens(scan.bundle.lifetimeTotal)}`);
  console.log(` 导入批次 ID  : ${scan.bundle.batchId}`);
  console.log('------------------------------------------------------');

  if (opts.dryRun) {
    console.log('[TokenMeter] 当前为 --dry-run 预览模式，未修改磁盘文件。');
    return;
  }

  mkdirSync(dirname(opts.target), { recursive: true });
  if (existsSync(opts.target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${opts.target}.pre-import-${stamp}.bak`;
    copyFileSync(opts.target, backupPath);
    console.log(`[TokenMeter] 已自动备份现有账本 -> ${backupPath}`);
  }

  const sidecarRunning = hasActiveOwnerLease(opts.target);
  const pendingPath = join(dirname(opts.target), 'pending-import.json');
  if (sidecarRunning) {
    // 严格遵守单写者租约契约：运行中仅原子投递 pending-import.json，由新启动的 sidecar 统一吸纳，绝不并发直写 ledger-v1.json
    const tmpPending = `${pendingPath}.${process.pid}.tmp`;
    writeFileSync(tmpPending, JSON.stringify(scan.bundle), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPending, pendingPath);
    console.log('[TokenMeter] 检测到 Antigravity sidecar 正在运行，已安全写入 pending-import.json 保护队列（未并发修改运行中的账本）。');
    console.log('[TokenMeter] 重启 Antigravity 加载 v1.2.15 后将自动原子吸纳并归档。');
    return;
  }

  const ledger = new UsageLedger(opts.target);
  const res = await ledger.applyImportBundle(scan.bundle);
  const snap = await ledger.snapshot();
  if (res.applied && existsSync(pendingPath)) {
    try { unlinkSync(pendingPath); } catch {}
  }

  console.log(
    res.applied
      ? `[TokenMeter] 迁移完成（重叠基线替换: ${res.replacedOverlap ? '是' : '否'}）。`
      : `[TokenMeter] 未写入账本（原因: ${res.reason}）。`
  );
  if (!res.applied && res.reason === 'corrupted_ledger') {
    process.exitCode = 1;
  }
  console.log(
    `[TokenMeter] 账本最新快照 -> 今日 ${fmtTokens(snap.todayTokens)} | 近 7 天 ${fmtTokens(snap.weekTokens)} | 本月 ${fmtTokens(snap.monthTokens)} | 累计 ${fmtTokens(snap.totalTokens)}`
  );
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  await main();
}
