#!/usr/bin/env node
/**
 * Antigravity TokenMeter 通用旧版用量历史导入工具（MIT License，零外部依赖）。
 *
 * 用途：
 * - 将旧版插件留在本机的 usage-v1 历史记录 JSON（按 id 去重）无损聚合迁移至 TokenMeter 账本；
 * - 写入前自动备份现有 ledger-v1.json；
 * - 通过 batchId + importedUntil 水位线实现 100% 幂等防重与防双倍记账；
 * - 严格对齐最新账本 Thinking/Output 计费口径与多平台路径解析（Windows / macOS / Linux）；
 * - 若检测到 Antigravity sidecar 正在后台运行，仅原子写入 pending-import.json 保护队列，
 *   避免运行中的旧进程内存刷盘覆盖导入结果，重启 Antigravity 后自动原子吸纳并归档。
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(SCRIPT_DIR, '..', 'antigravity-token-meter');
const LEDGER_MODULE = resolve(PLUGIN_DIR, 'sidecars', 'meter', 'src', 'ledger.mjs');
const PATHS_MODULE = resolve(PLUGIN_DIR, 'sidecars', 'meter', 'src', 'paths.mjs');
const { UsageLedger, toLocalDateKey } = await import(pathToFileURL(LEDGER_MODULE).href);
const { resolvePaths } = await import(pathToFileURL(PATHS_MODULE).href);

const LEASE_STALE_MS = 24000;
const LEASE_CORRUPT_GRACE_MS = 3000;

function readPluginVersion() {
  try {
    const raw = readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {}
  return '1.2.16';
}

const PLUGIN_VERSION = readPluginVersion();

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

function fmtUsd(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

function expandUserPath(rawPath, homeDir) {
  if (typeof rawPath !== 'string') return '';
  const trimmed = rawPath.trim();
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homeDir, trimmed.slice(2));
  }
  return trimmed;
}

function parseArgs(argv) {
  const defaultPaths = resolvePaths({
    home: process.env.AG_TEST_HOME || undefined,
    env: process.env,
  });
  const opts = {
    source: join(defaultPaths.appDataDir, 'sidecar_data', 'antigravity-pulse', 'panel', 'data', 'usage-v1'),
    target: defaultPaths.ledgerFile,
    dryRun: false,
    replaceOverlap: true,
    help: false,
    error: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--no-replace-overlap') {
      opts.replaceOverlap = false;
    } else if (arg === '--source') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        opts.error = '参数 --source 缺少目录或文件路径。';
        break;
      }
      opts.source = resolve(expandUserPath(next, defaultPaths.home));
      i++;
    } else if (arg.startsWith('--source=')) {
      const val = arg.slice('--source='.length);
      if (!val.trim()) {
        opts.error = '参数 --source 不能为空。';
        break;
      }
      opts.source = resolve(expandUserPath(val, defaultPaths.home));
    } else if (arg === '--target') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        opts.error = '参数 --target 缺少文件路径。';
        break;
      }
      opts.target = resolve(expandUserPath(next, defaultPaths.home));
      i++;
    } else if (arg.startsWith('--target=')) {
      const val = arg.slice('--target='.length);
      if (!val.trim()) {
        opts.error = '参数 --target 不能为空。';
        break;
      }
      opts.target = resolve(expandUserPath(val, defaultPaths.home));
    } else {
      opts.error = `未知参数: ${arg}（使用 --help 查看用法）`;
      break;
    }
  }
  return opts;
}

/**
 * 兼容毫秒时间戳、10 位秒级 Unix 时间戳及 ISO-8601 字符串。
 */
export function parseTimestampMs(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return NaN;
    // 10 位 Unix 秒级时间戳（1e9 ~ <1e12）自动换算为毫秒
    if (raw >= 1e9 && raw < 1e12) return Math.round(raw * 1000);
    return Math.round(raw);
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return NaN;
    if (/^\d{10,15}$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n) || n <= 0) return NaN;
      if (n >= 1e9 && n < 1e12) return Math.round(n * 1000);
      return Math.round(n);
    }
    const ms = Date.parse(s);
    return Number.isFinite(ms) && ms > 0 ? ms : NaN;
  }
  return NaN;
}

function printHelp() {
  console.log([
    `Antigravity TokenMeter 历史用量迁移工具 (v${PLUGIN_VERSION})`,
    '',
    '用法:',
    '  node scripts/import_legacy_usage.mjs [选项]',
    '',
    '选项:',
    '  --source <目录或文件>    指定旧版 usage-v1 历史目录或单个 JSON 文件（默认自动定位本机数据目录）',
    '  --target <文件>          指定目标 ledger-v1.json 路径（默认自动定位 TokenMeter 账本）',
    '  --dry-run                仅预览扫描与统计结果，不写入磁盘',
    '  --no-replace-overlap     强制叠加模式，不替换首次导入截断日前的试运行重叠数据',
    '  -h, --help               显示帮助信息',
  ].join('\n'));
}

function walkJsonFiles(targetPath, out = []) {
  if (!existsSync(targetPath)) return out;
  let st;
  try {
    st = statSync(targetPath);
  } catch {
    return out;
  }
  if (st.isFile()) {
    if (targetPath.toLowerCase().endsWith('.json')) out.push(targetPath);
    return out;
  }
  if (!st.isDirectory()) return out;
  for (const ent of readdirSync(targetPath, { withFileTypes: true })) {
    const full = join(targetPath, ent.name);
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

/**
 * 与 owner-lock.mjs 严格对齐的活跃租约判定：
 * - 若 PID 已退出，即使 heartbeatAt 刚过期也判定为非活跃（不误阻直写）；
 * - 若 PID 存活且心跳新鲜（<24s），判定为 sidecar 运行中，改写 pending-import.json 保护队列。
 */
export function hasActiveOwnerLease(ledgerPath) {
  const leasePath = join(dirname(ledgerPath), 'owner-lease.json');
  if (!existsSync(leasePath)) return false;
  try {
    const raw = JSON.parse(readFileSync(leasePath, 'utf8').replace(/^\uFEFF/, ''));
    const expiresAt = Number(raw?.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
      if (!Number.isInteger(raw?.pid) || isPidAlive(raw.pid)) return true;
      return false;
    }
    const heartbeatAt = Number(raw?.heartbeatAt);
    if (Number.isInteger(raw?.pid)) {
      if (!isPidAlive(raw.pid)) return false;
      if (Number.isFinite(heartbeatAt)) {
        return Date.now() - heartbeatAt < LEASE_STALE_MS;
      }
      return true;
    }
    if (Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt < LEASE_STALE_MS) {
      return true;
    }
    return false;
  } catch {
    // 锁文件瞬时写入窗口内解析失败时按宽限期保守视为活跃，防止并发竞争
    try {
      const st = statSync(leasePath);
      return Date.now() - st.mtimeMs < LEASE_CORRUPT_GRACE_MS;
    } catch {
      return false;
    }
  }
}

function writeAtomicJsonSync(targetPath, payload) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    let lastErr = null;
    for (let i = 0; i < 4; i++) {
      try {
        renameSync(tmp, targetPath);
        return;
      } catch (err) {
        lastErr = err;
        const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
        if (!transient || i === 3) throw err;
      }
    }
    if (lastErr) throw lastErr;
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function buildLegacyImportBundle(sourceDir, { replaceOverlap = true } = {}) {
  const files = walkJsonFiles(sourceDir);
  if (files.length === 0) {
    return { filesScanned: 0, parseErrors: 0, recordCount: 0, bundle: null };
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

        const input = safeInt(rec.uncached ?? rec.inputTokens ?? rec.input) + safeInt(rec.cacheWrite ?? rec.cacheWriteTokens);
        const cacheRead = safeInt(rec.cacheRead ?? rec.cacheReadTokens);
        const thinking = safeInt(rec.thinking ?? rec.thinkingTokens);
        const rawOutput = safeInt(rec.output ?? rec.outputTokens);
        const respOutRaw = rec.responseOutputTokens ?? rec.responseOutput;
        const respOut = respOutRaw !== undefined && respOutRaw !== null ? safeInt(respOutRaw) : null;
        // 与 ledger.mjs 计费口径严格对齐：output 保证包含 thinking 且绝不双倍计算（兼容纯思考步与分列字段）
        const output = respOut !== null && thinking > 0
          ? Math.max(rawOutput, respOut + thinking)
          : Math.max(rawOutput, thinking);
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
  if (opts.error) {
    console.error(`[TokenMeter] ${opts.error}`);
    process.exitCode = 1;
    return;
  }
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
  console.log(` Antigravity TokenMeter 历史用量迁移预览 (v${PLUGIN_VERSION})`);
  console.log('======================================================');
  console.log(` 数据来源     : ${opts.source}`);
  console.log(` 目标账本     : ${opts.target}`);
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
    writeAtomicJsonSync(pendingPath, scan.bundle);
    console.log('[TokenMeter] 检测到 Antigravity sidecar 正在运行，已安全写入 pending-import.json 保护队列（未并发修改运行中的账本）。');
    console.log(`[TokenMeter] 彻底退出并重启 Antigravity 加载 v${PLUGIN_VERSION} 后将自动原子吸纳并归档。`);
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
    `[TokenMeter] 账本最新快照 -> 今日 ${fmtTokens(snap.todayTokens)} | 近 7 天 ${fmtTokens(snap.weekTokens)} | 本月 ${fmtTokens(snap.monthTokens)} (${fmtUsd(snap.monthCostUsd)}) | 累计 ${fmtTokens(snap.totalTokens)} (${fmtUsd(snap.totalCostUsd)})`
  );
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    const scriptReal = realpathSync(fileURLToPath(import.meta.url));
    const argvReal = realpathSync(resolve(process.argv[1]));
    return scriptReal === argvReal;
  } catch {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  }
}

if (isDirectExecution()) {
  await main();
}
