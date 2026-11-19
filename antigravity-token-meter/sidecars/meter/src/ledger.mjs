/**
 * 并发安全、防原型污染的本地持久化 Token 用量账本。
 *
 * 工程保障：
 * 1. 所有动态索引容器使用无原型对象（Object.create(null)）重建，彻底杜绝 __proto__/constructor 原型污染；
 * 2. 首次 load 共享单一 loadPromise；严格区分 ENOENT（初始化）与损坏文件（保留磁盘原件不静默覆盖）；
 * 3. 支持按事件 ID 差值 upsert（流式中间快照变完整最终态时自动补记差值，零重复零漏记）；
 * 4. 使用单调 revision / committedRevision 驱动循环原子落盘（随机临时文件 + rename），杜绝并发丢写；
 * 5. 将 lifetimeTotal 永久累计与 400 天滚动日桶分离统计。
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { computeTokenCost, getModelPricing } from './pricing.mjs';

const MAX_RECORDS = 10000;
const MAX_DAYS = 400;
const MAX_APPLIED_IMPORTS = 64;

function safeInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(n)) : 0;
}

function safeFloat(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function toLocalDateKey(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  const valid = Number.isFinite(d.getTime()) ? d : new Date();
  return `${valid.getFullYear()}-${String(valid.getMonth() + 1).padStart(2, '0')}-${String(valid.getDate()).padStart(2, '0')}`;
}

function createEmptyState() {
  return {
    schema: 2,
    lifetimeTotal: 0,
    importedUntil: null,
    evictedUntil: null,
    appliedImports: [],
    recordOrder: [],
    records: Object.create(null),
    days: Object.create(null),
    models: Object.create(null),
    updatedAt: null,
  };
}

/**
 * 兼容 Windows 瞬时文件句柄占用的原子替换重试辅助函数。
 */
async function renameWithRetry(tmpPath, dstPath, maxAttempts = 4) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await rename(tmpPath, dstPath);
      return;
    } catch (err) {
      const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
      if (!transient || i === maxAttempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
}

function rebuildSafeState(parsed) {
  const next = createEmptyState();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.schema !== 2) return null;
  // 严格校验核心顶层结构，残缺或类型损坏的 schema:2 一律拒绝并保留原文件
  if (
    !Number.isSafeInteger(parsed.lifetimeTotal) || parsed.lifetimeTotal < 0 ||
    !parsed.days || typeof parsed.days !== 'object' || Array.isArray(parsed.days) ||
    !parsed.models || typeof parsed.models !== 'object' || Array.isArray(parsed.models) ||
    !Array.isArray(parsed.recordOrder) ||
    !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)
  ) {
    return null;
  }

  next.lifetimeTotal = safeInt(parsed.lifetimeTotal);
  next.importedUntil = typeof parsed.importedUntil === 'string' && Number.isFinite(Date.parse(parsed.importedUntil))
    ? parsed.importedUntil
    : null;
  next.evictedUntil = typeof parsed.evictedUntil === 'string' && Number.isFinite(Date.parse(parsed.evictedUntil))
    ? parsed.evictedUntil
    : null;
  if (Array.isArray(parsed.appliedImports)) {
    next.appliedImports = parsed.appliedImports
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => v.trim().slice(0, 80))
      .slice(-MAX_APPLIED_IMPORTS);
  }
  next.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;

  if (parsed.days && typeof parsed.days === 'object' && !Array.isArray(parsed.days)) {
    for (const [dateKey, entry] of Object.entries(parsed.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !entry || typeof entry !== 'object') continue;
      const byModel = Object.create(null);
      if (entry.byModel && typeof entry.byModel === 'object' && !Array.isArray(entry.byModel)) {
        for (const [mKey, mVal] of Object.entries(entry.byModel)) {
          byModel[String(mKey).slice(0, 128)] = safeInt(mVal);
        }
      }
      next.days[dateKey] = {
        total: safeInt(entry.total),
        input: safeInt(entry.input),
        cacheRead: safeInt(entry.cacheRead),
        output: safeInt(entry.output),
        requests: safeInt(entry.requests),
        byModel,
      };
    }
  }

  if (parsed.models && typeof parsed.models === 'object' && !Array.isArray(parsed.models)) {
    for (const [mKey, m] of Object.entries(parsed.models)) {
      if (!m || typeof m !== 'object') continue;
      next.models[String(mKey).slice(0, 128)] = {
        total: safeInt(m.total),
        input: safeInt(m.input),
        cacheRead: safeInt(m.cacheRead),
        output: safeInt(m.output),
        thinking: safeInt(m.thinking),
        requests: safeInt(m.requests),
        timedOutput: safeInt(m.timedOutput),
        streamingSec: safeFloat(m.streamingSec),
      };
    }
  }

  if (Array.isArray(parsed.recordOrder) && parsed.records && typeof parsed.records === 'object') {
    for (const rawId of parsed.recordOrder.slice(-MAX_RECORDS)) {
      const id = String(rawId);
      const rec = Object.hasOwn(parsed.records, id) ? parsed.records[id] : null;
      if (!rec || typeof rec !== 'object') continue;
      next.recordOrder.push(id);
      next.records[id] = {
        dateKey: typeof rec.dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rec.dateKey) ? rec.dateKey : toLocalDateKey(),
        ts: safeInt(rec.ts),
        model: String(rec.model || 'Unknown').slice(0, 128),
        input: safeInt(rec.input),
        cacheRead: safeInt(rec.cacheRead),
        output: safeInt(rec.output),
        thinking: safeInt(rec.thinking),
        timedOutput: safeInt(rec.timedOutput),
        streamingSec: safeFloat(rec.streamingSec),
      };
    }
  }

  return next;
}

export class UsageLedger {
  /**
   * @param {string | null} filePath
   * @param {{ readOnly?: boolean }} [options]
   */
  constructor(filePath, { readOnly = false } = {}) {
    this.filePath = filePath;
    this.readOnly = readOnly;
    this.state = createEmptyState();
    this.corrupted = false;
    this.lastWriteError = null;
    this._loadPromise = null;
    this._revision = 0;
    this._committedRevision = 0;
    this._flushPromise = null;
  }

  async load() {
    if (!this._loadPromise) {
      this._loadPromise = (async () => {
        if (!this.filePath) return;
        try {
          const raw = await readFile(this.filePath, 'utf8');
          const rebuilt = rebuildSafeState(JSON.parse(raw.replace(/^\uFEFF/, '')));
          if (rebuilt) {
            this.state = rebuilt;
          } else {
            // 发现无法识别或损坏文件时保留磁盘原件，禁止静默覆写覆盖用户历史
            this.corrupted = true;
          }
        } catch (err) {
          if (err?.code !== 'ENOENT') {
            this.corrupted = true;
          }
        }
        if (!this.readOnly && !this.corrupted && this.filePath) {
          await this._consumePendingImport();
        }
      })();
    }
    return this._loadPromise;
  }

  /**
   * 校验并应用离线生成的聚合历史导入包（幂等防重，支持自动处理导入前重叠试运行账本）。
   * @param {any} bundle
   * @param {{ skipFlush?: boolean }} [options]
   */
  async applyImportBundle(bundle, { skipFlush = false } = {}) {
    if (!skipFlush) await this.load();
    if (this.readOnly) return { applied: false, reason: 'readonly' };
    if (this.corrupted) return { applied: false, reason: 'corrupted_ledger' };
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || bundle.schema !== 1) {
      return { applied: false, reason: 'invalid_bundle' };
    }
    const batchId = typeof bundle.batchId === 'string' ? bundle.batchId.trim().slice(0, 80) : '';
    if (!batchId) return { applied: false, reason: 'missing_batch_id' };
    if (this.state.appliedImports.includes(batchId)) {
      return { applied: false, reason: 'already_applied' };
    }

    const cutoffIso = typeof bundle.importedUntil === 'string' && Number.isFinite(Date.parse(bundle.importedUntil))
      ? new Date(Date.parse(bundle.importedUntil)).toISOString()
      : null;

    // 首次导入且开启重叠替换时，仅保留晚于截断日的新日期增量及原始记录 ID，防止后续轮询把次日新数据翻倍双记
    const shouldReplaceOverlap =
      bundle.replaceOverlappingBeforeCutoff === true &&
      !this.state.importedUntil &&
      cutoffIso !== null;

    let futureDaysFallback = null;
    let preservedRecords = null;
    if (shouldReplaceOverlap) {
      const cutoffDateKey = toLocalDateKey(cutoffIso);
      preservedRecords = [];
      const coveredFutureDates = new Set();
      for (const id of this.state.recordOrder) {
        const rec = Object.hasOwn(this.state.records, id) ? this.state.records[id] : null;
        if (rec && rec.dateKey > cutoffDateKey) {
          preservedRecords.push([id, rec]);
          coveredFutureDates.add(rec.dateKey);
        }
      }
      futureDaysFallback = Object.create(null);
      for (const [k, entry] of Object.entries(this.state.days)) {
        if (k > cutoffDateKey && !coveredFutureDates.has(k)) {
          futureDaysFallback[k] = entry;
        }
      }
      this.state.lifetimeTotal = 0;
      this.state.recordOrder = [];
      this.state.records = Object.create(null);
      this.state.days = Object.create(null);
      this.state.models = Object.create(null);
    }

    let addedDayTotal = 0;
    if (bundle.days && typeof bundle.days === 'object' && !Array.isArray(bundle.days)) {
      for (const [dateKey, entry] of Object.entries(bundle.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !entry || typeof entry !== 'object') continue;
        const total = safeInt(entry.total);
        const input = safeInt(entry.input);
        const cacheRead = safeInt(entry.cacheRead);
        const output = safeInt(entry.output);
        const requests = safeInt(entry.requests);
        if (total <= 0 && requests <= 0) continue;

        if (!Object.hasOwn(this.state.days, dateKey)) {
          this.state.days[dateKey] = {
            total: 0,
            input: 0,
            cacheRead: 0,
            output: 0,
            requests: 0,
            byModel: Object.create(null),
          };
        }
        const d = this.state.days[dateKey];
        d.total += total;
        d.input += input;
        d.cacheRead += cacheRead;
        d.output += output;
        d.requests += requests;
        if (entry.byModel && typeof entry.byModel === 'object' && !Array.isArray(entry.byModel)) {
          for (const [mKey, mVal] of Object.entries(entry.byModel)) {
            const safeModel = String(mKey || 'Unknown').slice(0, 128);
            d.byModel[safeModel] = (d.byModel[safeModel] || 0) + safeInt(mVal);
          }
        }
        addedDayTotal += total;
      }
    }

    if (bundle.models && typeof bundle.models === 'object' && !Array.isArray(bundle.models)) {
      for (const [mKey, m] of Object.entries(bundle.models)) {
        if (!m || typeof m !== 'object') continue;
        const safeModel = String(mKey || 'Unknown').slice(0, 128);
        if (!Object.hasOwn(this.state.models, safeModel)) {
          this.state.models[safeModel] = {
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
        const dst = this.state.models[safeModel];
        dst.total += safeInt(m.total);
        dst.input += safeInt(m.input);
        dst.cacheRead += safeInt(m.cacheRead);
        dst.output += safeInt(m.output);
        dst.thinking += safeInt(m.thinking);
        dst.requests += safeInt(m.requests);
        dst.timedOutput += safeInt(m.timedOutput);
        dst.streamingSec += safeFloat(m.streamingSec);
      }
    }

    const bundleLifetime = safeInt(bundle.lifetimeTotal);
    this.state.lifetimeTotal += Math.max(bundleLifetime, addedDayTotal);

    // 还原严格晚于截断日期的未来增量记录（保留原始 ID 与完整字段，既防止后续轮询双记又完整保留 models 明细）
    if (preservedRecords && preservedRecords.length > 0) {
      for (const [id, rec] of preservedRecords) {
        this.state.records[id] = rec;
        this.state.recordOrder.push(id);
        this._applyDelta(rec.dateKey, rec.model, {
          input: rec.input,
          cacheRead: rec.cacheRead,
          output: rec.output,
          thinking: rec.thinking,
          timedOutput: rec.timedOutput,
          streamingSec: rec.streamingSec,
        }, true);
      }
    }
    if (futureDaysFallback) {
      for (const [dateKey, entry] of Object.entries(futureDaysFallback)) {
        if (!Object.hasOwn(this.state.days, dateKey)) {
          this.state.days[dateKey] = entry;
          this.state.lifetimeTotal += safeInt(entry.total);
          for (const [mKey, mVal] of Object.entries(entry.byModel || {})) {
            const safeModel = String(mKey || 'Unknown').slice(0, 128);
            if (!Object.hasOwn(this.state.models, safeModel)) {
              this.state.models[safeModel] = {
                total: 0, input: 0, cacheRead: 0, output: 0, thinking: 0, requests: 0, timedOutput: 0, streamingSec: 0,
              };
            }
            this.state.models[safeModel].total += safeInt(mVal);
          }
        }
      }
    }

    if (cutoffIso) {
      const prevMs = this.state.importedUntil ? Date.parse(this.state.importedUntil) : 0;
      const nextMs = Date.parse(cutoffIso);
      if (nextMs > prevMs) this.state.importedUntil = cutoffIso;
    }

    this.state.appliedImports.push(batchId);
    if (this.state.appliedImports.length > MAX_APPLIED_IMPORTS) {
      this.state.appliedImports = this.state.appliedImports.slice(-MAX_APPLIED_IMPORTS);
    }

    const dayKeys = Object.keys(this.state.days).sort();
    if (dayKeys.length > MAX_DAYS) {
      for (const k of dayKeys.slice(0, dayKeys.length - MAX_DAYS)) {
        delete this.state.days[k];
      }
    }

    this.state.updatedAt = new Date().toISOString();
    this._revision++;
    if (!skipFlush) {
      await this.flush();
    }
    return { applied: true, batchId, replacedOverlap: shouldReplaceOverlap };
  }

  /**
   * 启动加载时自动吸纳同目录的 pending-import.json，确保即使在宿主运行期间执行导入脚本也不会被旧内存覆写。
   */
  async _consumePendingImport() {
    const pendingPath = join(dirname(this.filePath), 'pending-import.json');
    let raw;
    try {
      raw = await readFile(pendingPath, 'utf8');
    } catch {
      return;
    }
    try {
      const bundle = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const res = await this.applyImportBundle(bundle, { skipFlush: true });
      if (res.applied) {
        await this._flushUnlocked();
      }
      if (res.applied || res.reason === 'already_applied') {
        const appliedPath = join(dirname(this.filePath), 'pending-import.applied.json');
        try {
          await rename(pendingPath, appliedPath);
        } catch {
          try { await unlink(pendingPath); } catch {}
        }
      }
    } catch {
      // 待导入包异常时静默忽略，不影响主账本启动
    }
  }

  _applyDelta(dateKey, model, delta, isNewRequest) {
    if (!Object.hasOwn(this.state.days, dateKey)) {
      this.state.days[dateKey] = {
        total: 0,
        input: 0,
        cacheRead: 0,
        output: 0,
        requests: 0,
        byModel: Object.create(null),
      };
    }
    const d = this.state.days[dateKey];
    const deltaTotal = delta.input + delta.cacheRead + delta.output;
    d.total = Math.max(0, d.total + deltaTotal);
    d.input = Math.max(0, d.input + delta.input);
    d.cacheRead = Math.max(0, d.cacheRead + delta.cacheRead);
    d.output = Math.max(0, d.output + delta.output);
    if (isNewRequest) d.requests += 1;
    d.byModel[model] = Math.max(0, (d.byModel[model] || 0) + deltaTotal);

    if (!Object.hasOwn(this.state.models, model)) {
      this.state.models[model] = {
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
    const m = this.state.models[model];
    m.total = Math.max(0, m.total + deltaTotal);
    m.input = Math.max(0, m.input + delta.input);
    m.cacheRead = Math.max(0, m.cacheRead + delta.cacheRead);
    m.output = Math.max(0, m.output + delta.output);
    m.thinking = Math.max(0, m.thinking + delta.thinking);
    if (isNewRequest) m.requests += 1;
    m.timedOutput = Math.max(0, m.timedOutput + delta.timedOutput);
    m.streamingSec = Math.max(0, m.streamingSec + delta.streamingSec);

    this.state.lifetimeTotal = Math.max(0, this.state.lifetimeTotal + deltaTotal);
  }

  /**
   * 写入或差值更新一批请求事件。
   */
  async ingest(events) {
    await this.load();
    if (!Array.isArray(events) || events.length === 0) return 0;

    let changed = 0;
    const evictedUntilMs = this.state.evictedUntil ? Date.parse(this.state.evictedUntil) : 0;
    for (const ev of events) {
      if (!ev || typeof ev.id !== 'string' || !ev.id) continue;
      const input = safeInt(ev.inputTokens) + safeInt(ev.cacheWriteTokens);
      const cacheRead = safeInt(ev.cacheReadTokens);
      const output = safeInt(ev.outputTokens);
      const thinking = safeInt(ev.thinkingTokens);
      const timedOutput = safeInt(ev.timedOutputTokens);
      const streamingSec = safeFloat(ev.streamingSeconds);
      if (input + cacheRead + output <= 0) continue;

      const id = ev.id.slice(0, 64);
      const model = String(ev.model || 'Unknown').slice(0, 128);
      const prev = Object.hasOwn(this.state.records, id) ? this.state.records[id] : null;

      if (!prev) {
        const parsedTs = typeof ev.timestamp === 'number'
          ? (Number.isFinite(ev.timestamp) ? ev.timestamp : NaN)
          : Date.parse(ev.timestamp || '');
        const evTs = Number.isFinite(parsedTs) && parsedTs > 0 ? Math.round(parsedTs) : Date.now();
        // 已被 MAX_RECORDS FIFO 淘汰的老请求不得因重启回填或翻阅旧会话而重复入账
        if (Number.isFinite(evictedUntilMs) && evictedUntilMs > 0 && Number.isFinite(parsedTs) && parsedTs <= evictedUntilMs) {
          continue;
        }
        const dateKey = toLocalDateKey(evTs);
        this.state.records[id] = { dateKey, ts: evTs, model, input, cacheRead, output, thinking, timedOutput, streamingSec };
        this.state.recordOrder.push(id);
        this._applyDelta(dateKey, model, { input, cacheRead, output, thinking, timedOutput, streamingSec }, true);
        changed++;
      } else {
        // 仅当新快照带来增长或补充了流式时长时按差值更新，防止乱序回退
        const dIn = Math.max(0, input - prev.input);
        const dCr = Math.max(0, cacheRead - prev.cacheRead);
        const dOut = Math.max(0, output - prev.output);
        const dTh = Math.max(0, thinking - prev.thinking);
        const dTimed = timedOutput > prev.timedOutput ? timedOutput - prev.timedOutput : 0;
        const dSec = streamingSec > prev.streamingSec ? streamingSec - prev.streamingSec : 0;
        if (dIn + dCr + dOut + dTh + dTimed > 0 || dSec > 0) {
          prev.input += dIn;
          prev.cacheRead += dCr;
          prev.output += dOut;
          prev.thinking += dTh;
          prev.timedOutput += dTimed;
          prev.streamingSec += dSec;
          this._applyDelta(prev.dateKey, prev.model, {
            input: dIn,
            cacheRead: dCr,
            output: dOut,
            thinking: dTh,
            timedOutput: dTimed,
            streamingSec: dSec,
          }, false);
          changed++;
        }
      }
    }

    if (changed > 0) {
      if (this.state.recordOrder.length > MAX_RECORDS) {
        const overflow = this.state.recordOrder.splice(0, this.state.recordOrder.length - MAX_RECORDS);
        let maxEvictedMs = this.state.evictedUntil ? Date.parse(this.state.evictedUntil) : 0;
        if (!Number.isFinite(maxEvictedMs)) maxEvictedMs = 0;
        for (const oldId of overflow) {
          const oldRec = Object.hasOwn(this.state.records, oldId) ? this.state.records[oldId] : null;
          if (oldRec) {
            const recMs = safeInt(oldRec.ts) || Date.parse(`${oldRec.dateKey}T23:59:59.999Z`);
            if (Number.isFinite(recMs) && recMs > maxEvictedMs) maxEvictedMs = recMs;
          }
          delete this.state.records[oldId];
        }
        if (maxEvictedMs > 0) {
          this.state.evictedUntil = new Date(maxEvictedMs).toISOString();
        }
      }
      const dayKeys = Object.keys(this.state.days).sort();
      if (dayKeys.length > MAX_DAYS) {
        for (const k of dayKeys.slice(0, dayKeys.length - MAX_DAYS)) {
          delete this.state.days[k];
        }
      }
      this.state.updatedAt = new Date().toISOString();
      this._revision++;
      await this.flush();
    }
    return changed;
  }

  async getImportedUntilMs() {
    await this.load();
    if (!this.state.importedUntil) return 0;
    const ms = Date.parse(this.state.importedUntil);
    return Number.isFinite(ms) ? ms : 0;
  }

  async getEvictedUntilMs() {
    await this.load();
    if (!this.state.evictedUntil) return 0;
    const ms = Date.parse(this.state.evictedUntil);
    return Number.isFinite(ms) ? ms : 0;
  }

  /**
   * 写入历史迁移水位线并安全落盘（供一次性历史账本导入工具调用，防后台回填重复记账）。
   */
  async setImportedUntil(isoString) {
    await this.load();
    if (typeof isoString !== 'string' || !Number.isFinite(Date.parse(isoString))) return;
    const prevMs = this.state.importedUntil ? Date.parse(this.state.importedUntil) : 0;
    const nextMs = Date.parse(isoString);
    if (nextMs > prevMs) {
      this.state.importedUntil = new Date(nextMs).toISOString();
      this.state.updatedAt = new Date().toISOString();
      this._revision++;
      await this.flush();
    }
  }

  /**
   * 基于版本号的循环原子刷盘：保证在途写完后若期间又有新写入会自动续刷，绝不丢账。
   */
  async flush() {
    await this.load();
    return this._flushUnlocked();
  }

  async _flushUnlocked() {
    if (this.readOnly || this.corrupted || !this.filePath) return;
    while (this._flushPromise) {
      try {
        await this._flushPromise;
      } catch {
        // 等待前一个落盘结束，后续重新评估版本号
      }
      if (this._committedRevision >= this._revision) return;
    }

    const current = (async () => {
      while (this._committedRevision < this._revision) {
        const targetRev = this._revision;
        const payload = JSON.stringify(this.state);
        const tmp = `${this.filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
        try {
          await mkdir(dirname(this.filePath), { recursive: true });
          await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
          await renameWithRetry(tmp, this.filePath);
          this._committedRevision = targetRev;
          this.lastWriteError = null;
        } catch (err) {
          this.lastWriteError = err?.code || 'write_failed';
          try { await unlink(tmp); } catch {}
          throw err;
        }
      }
    })();

    this._flushPromise = current;
    try {
      await current;
    } finally {
      if (this._flushPromise === current) {
        this._flushPromise = null;
      }
    }
  }

  async snapshot(now = new Date()) {
    await this.load();
    const todayKey = toLocalDateKey(now);
    const monthPrefix = todayKey.slice(0, 7);

    const weekKeys = new Set();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      weekKeys.add(toLocalDateKey(d));
    }

    let todayTokens = 0;
    let todayInput = 0;
    let todayCacheRead = 0;
    let todayOutput = 0;
    let todayRequests = 0;
    let todayByModel = [];
    let weekTokens = 0;
    let monthTokens = 0;
    let monthInput = 0;
    let monthCacheRead = 0;
    let monthOutput = 0;
    let monthRequests = 0;
    let totalRequests = 0;
    let peakDay = null;
    let todayCostUsd = 0;
    let weekCostUsd = 0;
    let monthCostUsd = 0;
    const daysList = [];

    // Precompute per-model cost profile for proportional daily estimation when day entries aggregate tokens
    const modelRatio = Object.create(null);
    let totalModelCostUsd = 0;
    let lifetimeCacheSavingsUsd = 0;
    for (const [mName, mStats] of Object.entries(this.state.models)) {
      const mTotal = Math.max(1, safeInt(mStats.total));
      const c = computeTokenCost({
        model: mName,
        inputTokens: safeInt(mStats.input),
        cacheReadTokens: safeInt(mStats.cacheRead),
        outputTokens: safeInt(mStats.output),
      }, now.getTime());
      if (c) {
        modelRatio[mName] = {
          inFrac: safeInt(mStats.input) / mTotal,
          cacheFrac: safeInt(mStats.cacheRead) / mTotal,
          outFrac: safeInt(mStats.output) / mTotal,
          totalUsd: c.costUsd,
        };
        totalModelCostUsd += c.costUsd;
        lifetimeCacheSavingsUsd += c.cacheSavingsUsd;
      }
    }

    const sortedKeys = Object.keys(this.state.days).sort();
    const recentCutoffIndex = Math.max(0, sortedKeys.length - 35);

    for (let idx = 0; idx < sortedKeys.length; idx++) {
      const key = sortedKeys[idx];
      const entry = this.state.days[key];
      const t = safeInt(entry?.total);
      const reqs = safeInt(entry?.requests);
      totalRequests += reqs;
      if (t > 0 && (!peakDay || t > peakDay.total)) {
        peakDay = { date: key, total: t };
      }
      if (key === todayKey) {
        todayTokens = t;
        todayInput = safeInt(entry?.input);
        todayCacheRead = safeInt(entry?.cacheRead);
        todayOutput = safeInt(entry?.output);
        todayRequests = reqs;
        if (entry?.byModel && typeof entry.byModel === 'object') {
          todayByModel = Object.entries(entry.byModel)
            .map(([model, totalTokens]) => ({ model: String(model), totalTokens: safeInt(totalTokens) }))
            .filter((x) => x.totalTokens > 0)
            .sort((a, b) => b.totalTokens - a.totalTokens)
            .slice(0, 6);
        }
      }
      if (weekKeys.has(key)) weekTokens += t;
      if (key.startsWith(monthPrefix)) {
        monthTokens += t;
        monthInput += safeInt(entry?.input);
        monthCacheRead += safeInt(entry?.cacheRead);
        monthOutput += safeInt(entry?.output);
        monthRequests += reqs;
      }
      const dayItem = {
        date: key,
        total: t,
        input: safeInt(entry?.input),
        cacheRead: safeInt(entry?.cacheRead),
        output: safeInt(entry?.output),
        requests: reqs,
      };
      let dayCostUsd = 0;
      if (entry?.byModel && typeof entry.byModel === 'object') {
        const bm = {};
        const bmc = {};
        let attributed = 0;
        for (const [mKey, mVal] of Object.entries(entry.byModel)) {
          const v = safeInt(mVal);
          if (v > 0) {
            const name = String(mKey);
            bm[name] = v;
            attributed += v;
            const r = modelRatio[name];
            const c = computeTokenCost({
              model: name,
              inputTokens: r ? v * r.inFrac : v * 0.04,
              cacheReadTokens: r ? v * r.cacheFrac : v * 0.93,
              outputTokens: r ? v * r.outFrac : v * 0.03,
            }, now.getTime());
            if (c) {
              dayCostUsd += c.costUsd;
              bmc[name] = Number(c.costUsd.toFixed(4));
            }
          }
        }
        if (t > attributed) {
          const rem = t - attributed;
          const remC = computeTokenCost({ model: 'Gemini 3.8 Flash', inputTokens: rem * 0.04, cacheReadTokens: rem * 0.93, outputTokens: rem * 0.03 }, now.getTime());
          if (remC) dayCostUsd += remC.costUsd;
        }
        if (idx >= recentCutoffIndex) {
          dayItem.byModel = bm;
          dayItem.byModelCost = bmc;
        }
      } else if (t > 0) {
        const estC = computeTokenCost({ model: 'Gemini 3.8 Flash', inputTokens: t * 0.04, cacheReadTokens: t * 0.93, outputTokens: t * 0.03 }, now.getTime());
        if (estC) dayCostUsd = estC.costUsd;
      }
      dayCostUsd = Number(dayCostUsd.toFixed(4));
      dayItem.costUsd = dayCostUsd;
      if (key === todayKey) todayCostUsd = dayCostUsd;
      if (weekKeys.has(key)) weekCostUsd += dayCostUsd;
      if (key.startsWith(monthPrefix)) monthCostUsd += dayCostUsd;
      daysList.push(dayItem);
    }

    // 计算当前连续活跃天数与历史最长连续活跃天数
    const activeDateSet = new Set(daysList.filter((d) => d.total > 0).map((d) => d.date));
    let currentStreak = 0;
    const cursor = new Date(now);
    if (!activeDateSet.has(toLocalDateKey(cursor))) {
      cursor.setDate(cursor.getDate() - 1);
    }
    while (activeDateSet.has(toLocalDateKey(cursor))) {
      currentStreak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    let longestStreak = 0;
    let runStreak = 0;
    let prevDayMs = null;
    for (const key of [...activeDateSet].sort()) {
      const [y, m, d] = key.split('-').map(Number);
      const utcMs = Date.UTC(y, m - 1, d);
      if (prevDayMs !== null && utcMs - prevDayMs === 86400000) {
        runStreak++;
      } else {
        runStreak = 1;
      }
      if (runStreak > longestStreak) longestStreak = runStreak;
      prevDayMs = utcMs;
    }

    const modelRank = Object.entries(this.state.models)
      .map(([name, m]) => {
        const pricing = getModelPricing(name, now);
        const mr = modelRatio[name];
        return {
          model: String(name),
          totalTokens: safeInt(m.total),
          outputTokens: safeInt(m.output),
          thinkingTokens: safeInt(m.thinking),
          cacheReadTokens: safeInt(m.cacheRead),
          requests: safeInt(m.requests),
          avgTps: m.streamingSec > 0 ? Number((m.timedOutput / m.streamingSec).toFixed(1)) : null,
          costUsd: mr ? Number(mr.totalUsd.toFixed(4)) : null,
          pricing,
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 20);

    return {
      todayDate: todayKey,
      monthKey: monthPrefix,
      todayTokens,
      todayCostUsd: Number(todayCostUsd.toFixed(4)),
      todayInput,
      todayCacheRead,
      todayOutput,
      todayRequests,
      todayByModel,
      weekTokens,
      weekCostUsd: Number(weekCostUsd.toFixed(4)),
      monthTokens,
      monthCostUsd: Number(monthCostUsd.toFixed(4)),
      monthInput,
      monthCacheRead,
      monthOutput,
      monthRequests,
      totalRequests,
      peakDay,
      currentStreak,
      longestStreak,
      activeDays: activeDateSet.size,
      totalTokens: safeInt(this.state.lifetimeTotal),
      totalCostUsd: Number(totalModelCostUsd.toFixed(4)),
      lifetimeCacheSavingsUsd: Number(lifetimeCacheSavingsUsd.toFixed(4)),
      importedUntil: this.state.importedUntil,
      days: daysList.slice(-365),
      modelRank,
      corrupted: this.corrupted,
      updatedAt: this.state.updatedAt,
    };
  }
}
