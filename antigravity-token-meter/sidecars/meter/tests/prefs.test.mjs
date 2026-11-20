import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PreferencesStore, detectDefaultLanguage, sanitizePrefsPatch } from '../src/prefs.mjs';
import { OwnerLease } from '../src/owner-lock.mjs';
import { resolvePaths } from '../src/paths.mjs';

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
    env: { AG_TM_PROFILE: '  /opt/custom-ag  ' },
  });
  assert.deepEqual(linuxPaths.profileCandidates, [
    '/opt/custom-ag',
    '/home/demo/.config/Antigravity',
    '/home/demo/.config/antigravity',
  ]);
});
