/**
 * 串行写队列 + 版本号保护的用户偏好设置持久化模块。
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_PREFS = Object.freeze({
  language: 'zh-CN',
  theme: 'swiss',
  showSpeed: true,
  showCache: true,
  showContext: true,
  showQuota: true,
  showToday: false,
  showMonth: true,
  showCost: false,
  version: 0,
});

const ALLOWED_LANGS = new Set(['zh-CN', 'en']);
const ALLOWED_THEMES = new Set(['swiss', 'glass', 'mono']);
const BOOL_KEYS = ['showSpeed', 'showCache', 'showContext', 'showQuota', 'showToday', 'showMonth', 'showCost'];

export function sanitizePrefsPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_prefs_payload');
  }
  const patch = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === 'language') {
      if (!ALLOWED_LANGS.has(v)) throw new Error('unsupported_language');
      patch.language = v;
    } else if (k === 'theme') {
      if (!ALLOWED_THEMES.has(v)) throw new Error('unsupported_theme');
      patch.theme = v;
    } else if (BOOL_KEYS.includes(k)) {
      if (typeof v !== 'boolean') throw new Error('invalid_boolean_pref');
      patch[k] = v;
    } else {
      throw new Error('unsupported_pref_key');
    }
  }
  return patch;
}

export class PreferencesStore {
  /**
   * @param {string | null} filePath
   * @param {{ readOnly?: boolean }} [options]
   */
  constructor(filePath, { readOnly = false } = {}) {
    this.filePath = filePath;
    this.readOnly = readOnly;
    this._cache = null;
    this._writeQueue = Promise.resolve();
  }

  async _readFromDisk() {
    const data = { ...DEFAULT_PREFS };
    if (!this.filePath) return data;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (ALLOWED_LANGS.has(parsed.language)) data.language = parsed.language;
        if (ALLOWED_THEMES.has(parsed.theme)) data.theme = parsed.theme;
        for (const k of BOOL_KEYS) {
          if (typeof parsed[k] === 'boolean') data[k] = parsed[k];
        }
        if (Number.isSafeInteger(parsed.version) && parsed.version >= 0) {
          data.version = parsed.version;
        }
      }
    } catch {
      // 文件不存在或损坏时使用默认预设
    }
    return data;
  }

  async get() {
    const fresh = await this._readFromDisk();
    this._cache = fresh;
    return { ...fresh };
  }

  /**
   * 通过串行队列执行 read-merge-write-commit，确保并行修改不丢字段且写失败不污染内存缓存。
   */
  update(patchInput) {
    const patch = sanitizePrefsPatch(patchInput);
    const task = this._writeQueue.then(async () => {
      if (this.readOnly) {
        throw new Error('preferences_readonly');
      }
      const current = await this._readFromDisk();
      const next = {
        ...current,
        ...patch,
        version: (current.version || 0) + 1,
      };
      if (this.filePath) {
        await mkdir(dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
          for (let i = 0; i < 3; i++) {
            try {
              await rename(tmp, this.filePath);
              break;
            } catch (err) {
              const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
              if (!transient || i === 2) throw err;
              await new Promise((r) => setTimeout(r, 40 * (i + 1)));
            }
          }
        } catch (err) {
          try { await unlink(tmp); } catch {}
          throw err;
        }
      }
      this._cache = next;
      return { ...next };
    });

    // 防止单次失败毒化后续队列
    this._writeQueue = task.catch(() => {});
    return task;
  }
}
