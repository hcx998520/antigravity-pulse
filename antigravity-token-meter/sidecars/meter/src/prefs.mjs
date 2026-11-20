/**
 * 串行写队列 + 版本号保护 + 首次安装语言自适应的用户偏好设置持久化模块。
 */
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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

/**
 * 解析单个区域设置标签：返回 'zh-CN' / 'en'，若为中性/无效标签（如 C、POSIX）则返回 null。
 * @param {unknown} raw
 * @returns {'zh-CN' | 'en' | null}
 */
function classifyLocaleTag(raw) {
  if (typeof raw !== 'string') return null;
  const first = raw.split(':')[0].trim();
  if (!first) return null;
  const cleaned = first.replace(/[.@].*$/, '').replace(/_/g, '-').trim();
  if (!cleaned || /^(?:c|posix)$/i.test(cleaned)) return null;
  if (/^zh(?:-|$)/i.test(cleaned)) return 'zh-CN';
  if (/^[a-z]{2,3}(?:-|$)/i.test(cleaned)) return 'en';
  return null;
}

/**
 * 检测首次安装（尚未落盘 preferences.json）时的默认界面语言。
 * 优先级：显式 AG_TM_LANG -> POSIX LC_ALL/LC_MESSAGES/LANG/LANGUAGE -> 系统 Intl 运行时区域 -> 回退 'zh-CN'。
 * @param {{ env?: Record<string, string | undefined>, locale?: string }} [opts]
 * @returns {'zh-CN' | 'en'}
 */
export function detectDefaultLanguage({ env = process.env, locale = undefined } = {}) {
  if (env && typeof env === 'object') {
    for (const key of ['AG_TM_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
      const hit = classifyLocaleTag(env[key]);
      if (hit) return hit;
    }
  }
  const explicitHit = classifyLocaleTag(locale);
  if (explicitHit) return explicitHit;
  try {
    const runtimeLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    const runtimeHit = classifyLocaleTag(runtimeLocale);
    if (runtimeHit) return runtimeHit;
  } catch {}
  return 'zh-CN';
}

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
  if (Object.keys(patch).length === 0) {
    throw new Error('empty_prefs_patch');
  }
  return patch;
}

export class PreferencesStore {
  /**
   * @param {string | null} filePath
   * @param {{ readOnly?: boolean, defaultLanguage?: 'zh-CN' | 'en', env?: Record<string, string | undefined>, locale?: string }} [options]
   */
  constructor(filePath, { readOnly = false, defaultLanguage = undefined, env = process.env, locale = undefined } = {}) {
    this.filePath = filePath;
    this.readOnly = readOnly;
    this.defaultLanguage = ALLOWED_LANGS.has(defaultLanguage)
      ? defaultLanguage
      : detectDefaultLanguage({ env, locale });
    this._cache = null;
    this._writeQueue = Promise.resolve();
  }

  _baseDefaults() {
    return {
      ...DEFAULT_PREFS,
      language: this.defaultLanguage,
    };
  }

  async _readFromDisk() {
    const data = this._baseDefaults();
    if (!this.filePath) return data;
    for (let i = 0; i < 3; i++) {
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
        break;
      } catch (err) {
        const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
        if (transient && i < 2) {
          await new Promise((r) => setTimeout(r, 25 * (i + 1)));
          continue;
        }
        // 文件不存在或损坏时使用默认预设
        break;
      }
    }
    return data;
  }

  async get() {
    const fresh = await this._readFromDisk();
    this._cache = fresh;
    return { ...fresh };
  }

  /**
   * 首次安装尚未生成 preferences.json 时，使用排他写（wx）安全落盘初始偏好（含自动检测的系统语言），
   * 绝不覆盖用户已有文件或并发更新。
   */
  ensureInitialized() {
    if (this.readOnly || !this.filePath) {
      return this.get();
    }
    const task = this._writeQueue.then(async () => {
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        const initial = { ...this._baseDefaults(), version: 1 };
        const fh = await open(this.filePath, 'wx', 0o600);
        try {
          await fh.writeFile(JSON.stringify(initial, null, 2) + '\n', 'utf8');
        } finally {
          await fh.close();
        }
        this._cache = initial;
        return { ...initial };
      } catch (err) {
        if (err?.code === 'EEXIST') {
          return this.get();
        }
        return this.get();
      }
    });
    this._writeQueue = task.catch(() => {});
    return task;
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
          for (let i = 0; i < 4; i++) {
            try {
              await rename(tmp, this.filePath);
              break;
            } catch (err) {
              const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
              if (!transient || i === 3) throw err;
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
