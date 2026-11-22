import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PreferencesStore, detectDefaultLanguage, sanitizePrefsPatch } from '../src/prefs.mjs';
import { OwnerLease } from '../src/owner-lock.mjs';
import { resolvePaths, readPluginFlags, resolveSidecarSdkCandidates } from '../src/paths.mjs';

test('PreferencesStore 白名单校验、并行更新串行化不丢字段且版本号单调递增', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-prefs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.throws(() => sanitizePrefsPatch({}));
  assert.throws(() => sanitizePrefsPatch({ language: 'fr' }));
  assert.throws(() => sanitizePrefsPatch({ theme: 'neon-cyber' }));
  assert.throws(() => sanitizePrefsPatch({ unknownKey: true }));
  assert.throws(() => sanitizePrefsPatch({ showSpeed: 'yes' }));
  assert.throws(() => sanitizePrefsPatch({ showMonth: 1 }));

  const store = new PreferencesStore(join(dir, 'preferences.json'));
  const initial = await store.get();
  assert.equal(initial.showMonth, true);

  const [r1, r2, r3, r4] = await Promise.all([
    store.update({ language: 'en' }),
    store.update({ showToday: true }),
    store.update({ theme: 'glass' }),
    store.update({ showMonth: false }),
  ]);
  assert.equal(r1.version, 1);
  assert.equal(r2.version, 2);
  assert.equal(r3.version, 3);
  assert.equal(r4.version, 4);

  const reloaded = new PreferencesStore(join(dir, 'preferences.json'));
  const saved = await reloaded.get();
  assert.equal(saved.language, 'en');
  assert.equal(saved.theme, 'glass');
  assert.equal(saved.showToday, true);
  assert.equal(saved.showMonth, false);
  assert.equal(saved.version, 4);
});

test('detectDefaultLanguage 与 ensureInitialized 首次安装自动适配中英文环境且不覆盖已有偏好', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-prefs-lang-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(detectDefaultLanguage({ env: { LANG: 'en_US.UTF-8' }, locale: 'zh-CN' }), 'en');
  assert.equal(detectDefaultLanguage({ env: { LANG: 'zh_CN.UTF-8' }, locale: 'en-US' }), 'zh-CN');
  assert.equal(detectDefaultLanguage({ env: { LANG: 'C.UTF-8' }, locale: 'ja-JP' }), 'en');
  assert.equal(detectDefaultLanguage({ env: { LANG: 'POSIX' }, locale: 'zh-Hans-CN' }), 'zh-CN');
  assert.equal(detectDefaultLanguage({ env: { AG_TM_LANG: 'en', LANG: 'zh_CN.UTF-8' }, locale: 'zh-CN' }), 'en');

  const prefsFile = join(dir, 'preferences.json');
  const enStore = new PreferencesStore(prefsFile, { env: {}, locale: 'en-US' });
  const initSnap = await enStore.ensureInitialized();
  assert.equal(initSnap.language, 'en');
  assert.equal(initSnap.version, 1);

  // 即使后续用中文默认环境重新打开，已落盘的用户偏好绝不被覆盖
  const zhEnvStore = new PreferencesStore(prefsFile, { env: {}, locale: 'zh-CN' });
  const afterReload = await zhEnvStore.ensureInitialized();
  assert.equal(afterReload.language, 'en');
  assert.equal(afterReload.version, 1);
});

test('OwnerLease 跨实例排他争锁、续期与释放正常，且 resolvePaths 兼容 Linux 大小写候选目录', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-lease-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const leasePath = join(dir, 'owner-lease.json');
  const leaseA = new OwnerLease(leasePath);
  const leaseB = new OwnerLease(leasePath);

  assert.equal(await leaseA.claim(), true);
  // 同一实例重入 claim 应直接保持拥有状态，不误判失锁
  assert.equal(await leaseA.claim(), true);
  assert.equal(await leaseB.claim(), false);
  assert.equal(await leaseA.renew(), true);
  await leaseA.release();
  assert.equal(await leaseB.claim(), true);
  await leaseB.release();

  // 过期死锁（PID 不存在）可自动回收接管
  await writeFile(
    leasePath,
    JSON.stringify({ token: 'dead-token', pid: 99999999, startedAt: 1000, heartbeatAt: 1000 }),
    'utf8'
  );
  const leaseC = new OwnerLease(leasePath);
  assert.equal(await leaseC.claim(), true);
  await leaseC.release();

  // 存活但已失联的孤儿进程持锁：canTakeover 返回 false 时绝不误抢，返回 true 时安全接管并令旧锁续期失败
  const orphanLease = new OwnerLease(leasePath, { lsPort: 53494 });
  assert.equal(await orphanLease.claim(), true);
  const newLease = new OwnerLease(leasePath, { lsPort: 60255 });
  assert.equal(await newLease.claim({ canTakeover: async () => false }), false);
  assert.equal(await orphanLease.renew(), true);
  assert.equal(await newLease.claim({ canTakeover: async (existing) => existing.lsPort === 53494 }), true);
  assert.equal(await orphanLease.renew(), false);
  assert.equal(orphanLease.owned, false);
  await newLease.release();

  const linuxPaths = resolvePaths({
    platform: 'linux',
    home: '/home/demo',
    env: { AG_TM_PROFILE: '  /opt/custom-ag  ', XDG_CONFIG_HOME: '/home/demo/.xdg-cfg' },
  });
  assert.deepEqual(linuxPaths.profileCandidates, [
    '/opt/custom-ag',
    '/home/demo/.xdg-cfg/Antigravity',
    '/home/demo/.xdg-cfg/antigravity',
    '/home/demo/.xdg-cfg/Antigravity - Insiders',
    '/home/demo/.xdg-cfg/antigravity-insiders',
    '/home/demo/.config/Antigravity',
    '/home/demo/.config/antigravity',
  ]);

  const winPaths = resolvePaths({
    platform: 'win32',
    home: 'C:\\Users\\测试 User',
    env: {
      APPDATA: 'D:\\CustomRoaming',
      LOCALAPPDATA: 'D:\\CustomLocal',
      ANTIGRAVITY_USER_DATA_DIR: 'E:\\Portable\\Antigravity',
    },
  });
  assert.deepEqual(winPaths.profileCandidates, [
    'E:\\Portable\\Antigravity',
    'D:\\CustomRoaming\\Antigravity',
    'D:\\CustomRoaming\\antigravity',
    'D:\\CustomRoaming\\Antigravity - Insiders',
    'D:\\CustomRoaming\\Antigravity Insiders',
    'C:\\Users\\测试 User\\AppData\\Roaming\\Antigravity',
    'C:\\Users\\测试 User\\AppData\\Roaming\\Antigravity - Insiders',
  ]);

  const macPaths = resolvePaths({
    platform: 'darwin',
    home: '/Users/demo',
    env: {},
  });
  assert.deepEqual(macPaths.profileCandidates, [
    '/Users/demo/Library/Application Support/Antigravity',
    '/Users/demo/Library/Application Support/antigravity',
    '/Users/demo/Library/Application Support/Antigravity - Insiders',
    '/Users/demo/Library/Application Support/Antigravity Insiders',
  ]);
});

test('readPluginFlags 区分零配置默认智能启用、显式禁用、配置损坏与 2.34+ 插件开关优先级', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-flags-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const settingsFile = join(dir, 'settings.json');
  const pluginConfigFile = join(dir, 'config.json');
  const mockPaths = { settingsFile, pluginConfigFile };

  // 1. 零配置（无 settings.json 且无 config.json）：默认智能启用 enabled=true, inline=true
  assert.deepEqual(readPluginFlags(mockPaths, {}), {
    enabled: true,
    inline: true,
    inlineSource: 'default',
    configError: false,
  });

  // 2. 环境变量 AG_TM_INLINE=false 可显式关闭内嵌
  assert.deepEqual(readPluginFlags(mockPaths, { AG_TM_INLINE: 'false' }), {
    enabled: true,
    inline: false,
    inlineSource: 'env',
    configError: false,
  });

  // 3. settings.json 仅写 enabled:true（未定义 inline）仍保持默认开启
  await writeFile(settingsFile, JSON.stringify({ enabled: true }), 'utf8');
  assert.deepEqual(readPluginFlags(mockPaths, {}), {
    enabled: true,
    inline: true,
    inlineSource: 'default',
    configError: false,
  });

  // 4. 用户在 settings.json 显式关闭 inline:false，必须严格尊重
  await writeFile(settingsFile, JSON.stringify({ enabled: true, inline: false }), 'utf8');
  assert.deepEqual(readPluginFlags(mockPaths, {}), {
    enabled: true,
    inline: false,
    inlineSource: 'settings',
    configError: false,
  });

  // 5. settings.json 类型错误或 JSON 损坏时保守关闭 inline 且标记 configError，不被 AG_TM_INLINE 掩盖
  await writeFile(settingsFile, JSON.stringify({ enabled: true, inline: 'yes' }), 'utf8');
  assert.deepEqual(readPluginFlags(mockPaths, { AG_TM_INLINE: 'true' }), {
    enabled: true,
    inline: false,
    inlineSource: 'error',
    configError: true,
  });
  await writeFile(settingsFile, '{broken-json', 'utf8');
  assert.deepEqual(readPluginFlags(mockPaths, {}), {
    enabled: true,
    inline: false,
    inlineSource: 'error',
    configError: true,
  });

  // 6. 兼容 Antigravity 2.34+：plugins 显式 enabled=true 时，残留的 sidecars.enabled=false 绝不触发误判自退
  await writeFile(settingsFile, JSON.stringify({ enabled: true, inline: true }), 'utf8');
  await writeFile(
    pluginConfigFile,
    JSON.stringify({
      plugins: { 'antigravity-token-meter': { enabled: true } },
      sidecars: { 'antigravity-token-meter/meter': { enabled: false } },
    }),
    'utf8'
  );
  assert.equal(readPluginFlags(mockPaths, {}).enabled, true);

  // 7. 若 plugins 未显式声明 enabled=true 而 sidecars 设为 false（2.33 停用）或 plugins 设为 false，均正确停用
  await writeFile(
    pluginConfigFile,
    JSON.stringify({
      sidecars: { 'antigravity-token-meter/meter': { enabled: false } },
    }),
    'utf8'
  );
  assert.equal(readPluginFlags(mockPaths, {}).enabled, false);

  await writeFile(
    pluginConfigFile,
    JSON.stringify({
      plugins: { 'antigravity-token-meter': { enabled: false } },
      sidecars: { 'antigravity-token-meter/meter': { enabled: true } },
    }),
    'utf8'
  );
  assert.equal(readPluginFlags(mockPaths, {}).enabled, false);
});

test('resolveSidecarSdkCandidates 跨平台支持 --import URL 解码、数据目录反推、ANTIGRAVITY_HOME 与 NODE_PATH', async () => {
  const winCands = resolveSidecarSdkCandidates({
    platform: 'win32',
    home: 'C:\\Users\\测试 User',
    execArgv: [
      '--import=file:///D:/Custom%20Dir/%E6%B5%8B%E8%AF%95/lib/node_modules/sidecar_sdk/register_loader.js',
    ],
    env: {
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: 'E:\\AppData\\sidecar_data\\antigravity-token-meter\\meter\\data',
      ANTIGRAVITY_HOME: 'F:\\AgHome',
      ANTIGRAVITY_GEMINI_DIR: 'G:\\GeminiDir',
      NODE_PATH: 'H:\\NodeLibs;I:\\MoreLibs',
      USERPROFILE: 'C:\\Users\\测试 User',
    },
  });
  assert.equal(winCands[0], 'D:\\Custom Dir\\测试\\lib\\node_modules\\sidecar_sdk\\index.mjs');
  assert.ok(winCands.includes('E:\\AppData\\lib\\node_modules\\sidecar_sdk\\index.mjs'));
  assert.ok(winCands.includes('F:\\AgHome\\lib\\node_modules\\sidecar_sdk\\index.mjs'));
  assert.ok(winCands.includes('G:\\GeminiDir\\antigravity\\lib\\node_modules\\sidecar_sdk\\index.mjs'));
  assert.ok(winCands.includes('H:\\NodeLibs\\sidecar_sdk\\index.mjs'));
  assert.ok(winCands.includes('C:\\Users\\测试 User\\.gemini\\antigravity\\lib\\node_modules\\sidecar_sdk\\index.mjs'));

  const macCands = resolveSidecarSdkCandidates({
    platform: 'darwin',
    home: '/Users/alice',
    execArgv: ['--import', 'file:///Users/alice/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js'],
    env: {
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: '/Users/alice/.gemini/antigravity-insiders/sidecar_data/antigravity-token-meter/meter/data',
      NODE_PATH: '/opt/ag/node_modules',
    },
  });
  assert.equal(macCands[0], '/Users/alice/.gemini/antigravity/lib/node_modules/sidecar_sdk/index.mjs');
  assert.ok(macCands.includes('/Users/alice/.gemini/antigravity-insiders/lib/node_modules/sidecar_sdk/index.mjs'));
  assert.ok(macCands.includes('/opt/ag/node_modules/sidecar_sdk/index.mjs'));
  // 确保 mkdir 未被 lint 误报未用：顺带验证 ANTIGRAVITY_GEMINI_DIR 推导 pluginConfigFile
  const dir = await mkdtemp(join(tmpdir(), 'tm-paths-'));
  await mkdir(join(dir, 'config'), { recursive: true });
  const p = resolvePaths({
    platform: process.platform,
    home: dir,
    env: { ANTIGRAVITY_GEMINI_DIR: dir },
  });
  assert.equal(p.pluginConfigFile, join(dir, 'config', 'config.json'));
  await rm(dir, { recursive: true, force: true });
});
