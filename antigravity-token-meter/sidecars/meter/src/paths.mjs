/**
 * 跨平台路径解析与配置开关读取（带严格类型校验，损坏配置不静默开启实验内嵌）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * 解析当前平台下 Antigravity 及 TokenMeter 插件路径。
 * @param {{ platform?: string, home?: string, env?: Record<string, string | undefined> }} [opts]
 */
export function resolvePaths({
  platform = process.platform,
  home = homedir(),
  env = process.env,
} = {}) {
  const pathImpl = platform === 'win32' ? win32 : posix;
  const { join, isAbsolute } = pathImpl;
  let appSupport;
  let localRoot;

  if (platform === 'win32') {
    appSupport = env.APPDATA || join(home, 'AppData', 'Roaming');
    localRoot = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  } else if (platform === 'darwin') {
    appSupport = join(home, 'Library', 'Application Support');
    localRoot = appSupport;
  } else {
    appSupport = env.XDG_CONFIG_HOME || join(home, '.config');
    localRoot = env.XDG_DATA_HOME || join(home, '.local', 'share');
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
  const envProfile = typeof env.AG_TM_PROFILE === 'string' && env.AG_TM_PROFILE.trim() && isAbsolute(env.AG_TM_PROFILE.trim())
    ? env.AG_TM_PROFILE.trim()
    : null;
  const savedProfile = typeof savedSettings.profile === 'string' && savedSettings.profile.trim() && isAbsolute(savedSettings.profile.trim())
    ? savedSettings.profile.trim()
    : null;

  const profileCandidates = [];
  for (const candidate of [
    envProfile,
    savedProfile,
    defaultProfile,
    platform === 'linux' ? join(appSupport, 'antigravity') : null,
  ]) {
    if (candidate && !profileCandidates.includes(candidate)) {
      profileCandidates.push(candidate);
    }
  }

  const dataDir =
    env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    join(home, '.gemini', 'antigravity', 'sidecar_data', 'antigravity-token-meter', 'meter', 'data');

  return {
    home,
    platform,
    profile: profileCandidates[0] || defaultProfile,
    profileCandidates,
    configDir,
    settingsFile,
    prefsFile,
    dataDir,
    ledgerFile: join(dataDir, 'ledger-v1.json'),
    statusFile: join(dataDir, 'integration-status.json'),
    ownerLockFile: join(dataDir, 'owner-lease.json'),
    pluginConfigFile: join(home, '.gemini', 'config', 'config.json'),
  };
}

/**
 * 读取插件启用与内嵌模式开关。
 * 安全原则：
 * - 若 settings.json 不存在，默认 enabled=true、inline=false（需显式启用实验内嵌模式，避免意外接入）；
 * - 若 settings.json 存在但格式损坏，保守关闭 inline（不静默打开实验内嵌）。
 * @param {ReturnType<typeof resolvePaths>} paths
 */
export function readPluginFlags(paths) {
  const result = { enabled: true, inline: false, configError: false };
  try {
    if (existsSync(paths.settingsFile)) {
      const s = JSON.parse(readFileSync(paths.settingsFile, 'utf8').replace(/^\uFEFF/, ''));
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        result.configError = true;
        result.inline = false;
      } else {
        if (s.enabled === false) result.enabled = false;
        result.inline = s.inline === true;
      }
    }
  } catch {
    result.configError = true;
    result.inline = false;
  }

  try {
    if (existsSync(paths.pluginConfigFile)) {
      const c = JSON.parse(readFileSync(paths.pluginConfigFile, 'utf8').replace(/^\uFEFF/, ''));
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        if (c.plugins?.['antigravity-token-meter']?.enabled === false) result.enabled = false;
        if (c.sidecars?.['antigravity-token-meter/meter']?.enabled === false) result.enabled = false;
      }
    }
  } catch {
    // 宿主配置文件读取异常时保留本地判定
  }
  return result;
}
