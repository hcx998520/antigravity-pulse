/**
 * 跨平台路径解析、官方 sidecar_sdk 候选定位与配置开关读取。
 *
 * 零配置开箱原则：
 * - 当用户直接复制插件或通过插件管理器启用（尚未生成 settings.json）时，默认智能启用 enabled=true、inline=true；
 * - 严格尊重用户显式禁用（settings.json 中 inline:false、AG_TM_INLINE=0/false，或宿主 config.json 停用）；
 * - 若 settings.json 存在但 JSON 损坏/字段类型非法，保守关闭 inline 并标记 configError=true。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

function normalizeAbsPath(raw, isAbsolute) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  return trimmed;
}

function splitProfileEnvList(raw, pathImpl) {
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const single = normalizeAbsPath(trimmed, pathImpl.isAbsolute);
  if (single && !trimmed.includes(pathImpl.delimiter)) return [single];
  const out = [];
  for (const part of trimmed.split(pathImpl.delimiter)) {
    const clean = normalizeAbsPath(part, pathImpl.isAbsolute);
    if (clean) out.push(clean);
  }
  if (out.length === 0 && single) out.push(single);
  return out;
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

/**
 * 从 ANTIGRAVITY_EXECUTABLE_DATA_DIR（格式 <appData>/sidecar_data/<plugin>/<sidecar>/data）
 * 向上反推当前运行宿主真实的 <appData> 目录（兼容自定义 --app_data_dir、Insiders 与多目录隔离）。
 */
export function inferAppDataDirFromExecutableDataDir(dataDir, pathImpl = process.platform === 'win32' ? win32 : posix) {
  const clean = normalizeAbsPath(dataDir, pathImpl.isAbsolute);
  if (!clean) return null;
  let cur = clean;
  for (let i = 0; i < 8; i++) {
    const parent = pathImpl.dirname(cur);
    if (!parent || parent === cur) break;
    if (pathImpl.basename(cur).toLowerCase() === 'sidecar_data') {
      return parent;
    }
    cur = parent;
  }
  return null;
}

/**
 * 解析当前平台下 Antigravity 及 TokenMeter 插件路径。
 * @param {{ platform?: string, home?: string, env?: Record<string, string | undefined> }} [opts]
 */
export function resolvePaths({
  platform = process.platform,
  home,
  env = process.env,
} = {}) {
  const pathImpl = platform === 'win32' ? win32 : posix;
  const { join, dirname, isAbsolute } = pathImpl;

  const resolvedHome =
    normalizeAbsPath(home, isAbsolute) ||
    normalizeAbsPath(platform === 'win32' ? (env.USERPROFILE || env.HOME) : (env.HOME || env.USERPROFILE), isAbsolute) ||
    homedir();

  let appSupport;
  let localRoot;

  if (platform === 'win32') {
    appSupport = normalizeAbsPath(env.APPDATA, isAbsolute) || join(resolvedHome, 'AppData', 'Roaming');
    localRoot = normalizeAbsPath(env.LOCALAPPDATA, isAbsolute) || join(resolvedHome, 'AppData', 'Local');
  } else if (platform === 'darwin') {
    appSupport = join(resolvedHome, 'Library', 'Application Support');
    localRoot = appSupport;
  } else {
    appSupport = normalizeAbsPath(env.XDG_CONFIG_HOME, isAbsolute) || join(resolvedHome, '.config');
    localRoot = normalizeAbsPath(env.XDG_DATA_HOME, isAbsolute) || join(resolvedHome, '.local', 'share');
  }

  const configDir = join(localRoot, 'AntigravityTokenMeter');
  const settingsFile = join(configDir, 'settings.json');
  const prefsFile = join(configDir, 'preferences.json');

  let savedSettings = {};
  try {
    if (existsSync(settingsFile)) {
      const parsed = JSON.parse(readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        savedSettings = parsed;
      }
    }
  } catch {
    savedSettings = {};
  }

  const defaultProfile = join(appSupport, 'Antigravity');
  const envProfiles = [
    ...splitProfileEnvList(env.AG_TM_PROFILE, pathImpl),
    ...splitProfileEnvList(env.ANTIGRAVITY_USER_DATA_DIR, pathImpl),
    ...splitProfileEnvList(env.ELECTRON_USER_DATA_DIR, pathImpl),
  ];
  const savedProfile = normalizeAbsPath(savedSettings.profile, isAbsolute);

  const profileCandidates = [];
  for (const p of envProfiles) pushUnique(profileCandidates, p);
  pushUnique(profileCandidates, savedProfile);

  if (platform === 'win32') {
    pushUnique(profileCandidates, defaultProfile);
    pushUnique(profileCandidates, join(appSupport, 'antigravity'));
    pushUnique(profileCandidates, join(appSupport, 'Antigravity - Insiders'));
    pushUnique(profileCandidates, join(appSupport, 'Antigravity Insiders'));
    const fallbackRoaming = join(resolvedHome, 'AppData', 'Roaming');
    if (fallbackRoaming !== appSupport) {
      pushUnique(profileCandidates, join(fallbackRoaming, 'Antigravity'));
      pushUnique(profileCandidates, join(fallbackRoaming, 'Antigravity - Insiders'));
    }
  } else if (platform === 'darwin') {
    pushUnique(profileCandidates, defaultProfile);
    pushUnique(profileCandidates, join(appSupport, 'antigravity'));
    pushUnique(profileCandidates, join(appSupport, 'Antigravity - Insiders'));
    pushUnique(profileCandidates, join(appSupport, 'Antigravity Insiders'));
  } else {
    pushUnique(profileCandidates, defaultProfile);
    pushUnique(profileCandidates, join(appSupport, 'antigravity'));
    pushUnique(profileCandidates, join(appSupport, 'Antigravity - Insiders'));
    pushUnique(profileCandidates, join(appSupport, 'antigravity-insiders'));
    const fallbackCfg = join(resolvedHome, '.config');
    if (fallbackCfg !== appSupport) {
      pushUnique(profileCandidates, join(fallbackCfg, 'Antigravity'));
      pushUnique(profileCandidates, join(fallbackCfg, 'antigravity'));
    }
  }

  const execDataDir = normalizeAbsPath(env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, isAbsolute);
  const inferredAppDataDir = inferAppDataDirFromExecutableDataDir(execDataDir, pathImpl);
  const explicitGeminiDir = normalizeAbsPath(env.ANTIGRAVITY_GEMINI_DIR, isAbsolute);
  const geminiDir =
    explicitGeminiDir ||
    (inferredAppDataDir && pathImpl.basename(dirname(inferredAppDataDir)) === '.gemini'
      ? dirname(inferredAppDataDir)
      : join(resolvedHome, '.gemini'));

  const appDataDir = inferredAppDataDir || join(geminiDir, 'antigravity');
  const dataDir =
    execDataDir ||
    join(appDataDir, 'sidecar_data', 'antigravity-token-meter', 'meter', 'data');

  return {
    home: resolvedHome,
    platform,
    geminiDir,
    appDataDir,
    profile: profileCandidates[0] || defaultProfile,
    profileCandidates,
    configDir,
    settingsFile,
    prefsFile,
    dataDir,
    ledgerFile: join(dataDir, 'ledger-v1.json'),
    statusFile: join(dataDir, 'integration-status.json'),
    ownerLockFile: join(dataDir, 'owner-lease.json'),
    pluginConfigFile: join(geminiDir, 'config', 'config.json'),
  };
}

/**
 * 收集官方 sidecar_sdk/index.mjs 跨平台候选路径（按精确度从高到低排序）。
 * 兼容：宿主 --import 预加载参数、ANTIGRAVITY_EXECUTABLE_DATA_DIR、ANTIGRAVITY_HOME、
 * ANTIGRAVITY_GEMINI_DIR、NODE_PATH、以及多平台 USERPROFILE / HOME / Insiders 目录。
 * @param {{ platform?: string, home?: string, env?: Record<string, string | undefined>, execArgv?: string[] }} [opts]
 */
export function resolveSidecarSdkCandidates({
  platform = process.platform,
  home,
  env = process.env,
  execArgv = process.execArgv,
} = {}) {
  const pathImpl = platform === 'win32' ? win32 : posix;
  const { join, dirname, isAbsolute } = pathImpl;
  const candidates = [];

  // 1. 宿主注入的 --import=.../sidecar_sdk/register_loader.js（支持中文与空格 URL 编码）
  if (Array.isArray(execArgv)) {
    for (let i = 0; i < execArgv.length; i++) {
      const arg = execArgv[i];
      if (typeof arg !== 'string') continue;
      let spec = null;
      if (arg.startsWith('--import=')) {
        spec = arg.slice('--import='.length).trim();
      } else if (arg === '--import' && typeof execArgv[i + 1] === 'string') {
        spec = execArgv[i + 1].trim();
      }
      if (!spec || !/sidecar_sdk/i.test(spec)) continue;
      try {
        let localPath = spec;
        if (/^file:\/\//i.test(spec)) {
          const u = new URL(spec);
          if (platform === 'win32') {
            localPath = decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\');
          } else {
            localPath = decodeURIComponent(u.pathname);
          }
        }
        const clean = normalizeAbsPath(localPath, isAbsolute);
        if (clean) {
          pushUnique(candidates, join(dirname(clean), 'index.mjs'));
        }
      } catch {}
    }
  }

  // 2. 由 ANTIGRAVITY_EXECUTABLE_DATA_DIR 反推宿主真实的 <appData>/lib/node_modules/sidecar_sdk
  const inferredAppData = inferAppDataDirFromExecutableDataDir(env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, pathImpl);
  if (inferredAppData) {
    pushUnique(candidates, join(inferredAppData, 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'));
  }

  // 3. ANTIGRAVITY_HOME / ANTIGRAVITY_GEMINI_DIR 显式目录
  const agHome = normalizeAbsPath(env.ANTIGRAVITY_HOME, isAbsolute);
  if (agHome) {
    pushUnique(candidates, join(agHome, 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'));
    pushUnique(candidates, join(agHome, 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'));
  }

  const agGemini = normalizeAbsPath(env.ANTIGRAVITY_GEMINI_DIR, isAbsolute);
  if (agGemini) {
    pushUnique(candidates, join(agGemini, 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'));
    pushUnique(candidates, join(agGemini, 'config', 'node_modules', 'sidecar_sdk', 'index.mjs'));
  }

  // 4. NODE_PATH（若宿主或用户显式设置）
  if (typeof env.NODE_PATH === 'string' && env.NODE_PATH.trim()) {
    for (const seg of env.NODE_PATH.split(pathImpl.delimiter)) {
      const clean = normalizeAbsPath(seg, isAbsolute);
      if (clean) {
        pushUnique(candidates, join(clean, 'sidecar_sdk', 'index.mjs'));
      }
    }
  }

  // 5. 多来源用户主目录回退（兼容 Windows USERPROFILE 与 POSIX HOME 混用场景）
  const homeList = [];
  const rawHomes = home ? [home, env.USERPROFILE, env.HOME] : [env.USERPROFILE, env.HOME, homedir()];
  for (const h of rawHomes) {
    const clean = normalizeAbsPath(h, isAbsolute);
    if (clean) pushUnique(homeList, clean);
  }
  for (const h of homeList) {
    pushUnique(candidates, join(h, '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'));
    pushUnique(candidates, join(h, '.gemini', 'antigravity-insiders', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'));
    pushUnique(candidates, join(h, '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs'));
  }

  return candidates;
}

function parseBoolEnv(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return null;
}

/**
 * 读取插件启用与内嵌模式开关。
 * 规则：
 * 1. 零配置默认启用：settings.json 缺失或未显式声明 inline 时默认 inline=true（inlineSource='default'），
 *    避免直接复制插件或由插件管理器启用时静默关闭核心底部状态条；
 * 2. 显式配置优先：settings.json 中 inline:false 或环境变量 AG_TM_INLINE=0/false 严格关闭内嵌；
 * 3. 安全兜底：settings.json 存在但 JSON 损坏/类型非法时保守关闭 inline 并置 configError=true；
 * 4. 兼容 Antigravity 2.33 与 2.34+ 宿主 config.json：
 *    - 2.34+ 以 plugins["antigravity-token-meter"].enabled 为插件及旗下 sidecar 唯一权威开关；
 *    - 仅当 plugins 项为 false，或 plugins 项未显式为 true 且 sidecars 项为 false 时才判定宿主已停用，
 *      彻底避免 2.34+ 在 UI 重新启用插件后因残留旧版 sidecars.enabled=false 引发误判自退。
 * @param {ReturnType<typeof resolvePaths>} paths
 * @param {Record<string, string | undefined>} [env]
 */
export function readPluginFlags(paths, env = process.env) {
  const result = {
    enabled: true,
    inline: true,
    inlineSource: 'default',
    configError: false,
  };

  try {
    if (paths?.settingsFile && existsSync(paths.settingsFile)) {
      const s = JSON.parse(readFileSync(paths.settingsFile, 'utf8').replace(/^\uFEFF/, ''));
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        result.configError = true;
        result.inline = false;
        result.inlineSource = 'error';
      } else {
        if (s.enabled === false) result.enabled = false;
        if (typeof s.inline === 'boolean') {
          result.inline = s.inline;
          result.inlineSource = 'settings';
        } else if (s.inline !== undefined) {
          result.configError = true;
          result.inline = false;
          result.inlineSource = 'error';
        }
      }
    }
  } catch {
    result.configError = true;
    result.inline = false;
    result.inlineSource = 'error';
  }

  // 允许环境变量显式覆盖内嵌开关（仅在本地配置文件未损坏时生效，避免掩盖配置损坏告警）
  const envInline = parseBoolEnv(env?.AG_TM_INLINE);
  if (envInline !== null && !result.configError) {
    result.inline = envInline;
    result.inlineSource = 'env';
  }

  try {
    if (paths?.pluginConfigFile && existsSync(paths.pluginConfigFile)) {
      const c = JSON.parse(readFileSync(paths.pluginConfigFile, 'utf8').replace(/^\uFEFF/, ''));
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        const pluginEnabled = c.plugins?.['antigravity-token-meter']?.enabled;
        const sidecarEnabled = c.sidecars?.['antigravity-token-meter/meter']?.enabled;
        if (pluginEnabled === false) {
          result.enabled = false;
        } else if (pluginEnabled !== true && sidecarEnabled === false) {
          result.enabled = false;
        }
      }
    }
  } catch {
    // 宿主配置文件读取异常时保留本地判定
  }
  return result;
}
