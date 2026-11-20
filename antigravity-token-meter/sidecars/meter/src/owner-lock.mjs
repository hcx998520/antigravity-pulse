/**
 * 基于排他锁文件（O_CREAT | O_EXCL）的跨进程单写者租约锁。
 * 绝不强抢仍在存活且未过期的持有者，防止双 sidecar 并发覆盖账本与状态。
 */
import { link, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const LEASE_TTL_MS = 12000;
const STALE_CORRUPT_GRACE_MS = 3000;

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export class OwnerLease {
  constructor(leaseFile, { lsPort = null } = {}) {
    this.leaseFile = leaseFile;
    this.lsPort = Number.isInteger(lsPort) && lsPort > 0 && lsPort <= 65535 ? lsPort : null;
    this.token = randomUUID();
    this.startedAt = Date.now();
    this.owned = false;
    this._timer = null;
  }

  async _readLease() {
    for (let i = 0; i < 3; i++) {
      try {
        const raw = await readFile(this.leaseFile, 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object' && typeof data.token === 'string') return data;
        return null;
      } catch (err) {
        const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
        if (transient && i < 2) {
          await new Promise((r) => setTimeout(r, 25 * (i + 1)));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  _payload() {
    return JSON.stringify({
      token: this.token,
      pid: process.pid,
      startedAt: this.startedAt,
      heartbeatAt: Date.now(),
      ...(this.lsPort ? { lsPort: this.lsPort } : {}),
    });
  }

  /**
   * 原子创建锁文件：先将完整内容写入临时文件再用硬链接原子发布，彻底消除创建空文件到写入完成的 TOCTOU 窗口。
   */
  async _tryCreateAtomic() {
    const tmp = `${this.leaseFile}.${process.pid}.${randomUUID().slice(0, 8)}.claim`;
    try {
      await writeFile(tmp, this._payload(), { encoding: 'utf8', mode: 0o600 });
      try {
        await link(tmp, this.leaseFile);
        return true;
      } catch (err) {
        if (err?.code === 'EEXIST') return false;
        // 某些不支持硬链接的文件系统安全降级为排他 wx 打开
        if (err?.code === 'EXDEV' || err?.code === 'ENOSYS' || err?.code === 'EPERM' || err?.code === 'ENOTSUP') {
          try {
            const fh = await open(this.leaseFile, 'wx', 0o600);
            try {
              await fh.writeFile(this._payload(), 'utf8');
            } finally {
              await fh.close();
            }
            return true;
          } catch (wxErr) {
            if (wxErr?.code === 'EEXIST') return false;
            throw wxErr;
          }
        }
        throw err;
      }
    } finally {
      try { await unlink(tmp); } catch {}
    }
  }

  /**
   * 通过原子发布抢占所有权；确认旧锁 PID 已退出、僵死超时、损坏超过宽限期，或经 canTakeover 证实旧锁为宿主失联孤儿时安全回收重试。
   * @param {{ canTakeover?: (existing: any) => boolean | Promise<boolean> }} [opts]
   */
  async claim({ canTakeover } = {}) {
    if (!this.leaseFile) {
      this.owned = true;
      return true;
    }
    await mkdir(dirname(this.leaseFile), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const created = await this._tryCreateAtomic();
        if (created) {
          this.owned = true;
          return true;
        }
        const existing = await this._readLease();
        let deadOrExpired = false;
        if (!existing) {
          // 读取解析失败时检查文件年龄，避免误删另一进程刚创建的锁文件
          try {
            const st = await stat(this.leaseFile);
            deadOrExpired = Date.now() - st.mtimeMs > STALE_CORRUPT_GRACE_MS;
          } catch {
            deadOrExpired = true;
          }
        } else {
          const heartbeatAge = Date.now() - Number(existing.heartbeatAt || 0);
          deadOrExpired = !isPidAlive(existing.pid) || heartbeatAge > LEASE_TTL_MS * 2;
          if (!deadOrExpired && typeof canTakeover === 'function' && existing.token !== this.token) {
            let takeover = false;
            try {
              takeover = Boolean(await canTakeover(existing));
            } catch {}
            if (takeover) {
              // 删除前二次核对 token 未被其他竞争者更新，确保绝不误删刚胜出的新 Owner
              const recheck = await this._readLease();
              if (recheck && recheck.token === existing.token) {
                deadOrExpired = true;
              }
            }
          }
        }
        if (!deadOrExpired) {
          this.owned = false;
          return false;
        }
        for (let u = 0; u < 3; u++) {
          try {
            await unlink(this.leaseFile);
            break;
          } catch (uErr) {
            const transient = uErr?.code === 'EPERM' || uErr?.code === 'EBUSY' || uErr?.code === 'EACCES';
            if (!transient || u === 2) break;
            await new Promise((r) => setTimeout(r, 35 * (u + 1)));
          }
        }
      } catch {
        this.owned = false;
        return false;
      }
    }
    this.owned = false;
    return false;
  }

  async renew() {
    if (!this.owned || !this.leaseFile) return false;
    const existing = await this._readLease();
    if (!existing || existing.token !== this.token) {
      this.owned = false;
      return false;
    }
    const tmp = `${this.leaseFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(tmp, this._payload(), { encoding: 'utf8', mode: 0o600 });
      for (let i = 0; i < 6; i++) {
        try {
          await rename(tmp, this.leaseFile);
          return true;
        } catch (err) {
          const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
          if (!transient || i === 5) throw err;
          await new Promise((r) => setTimeout(r, 40 * (i + 1)));
        }
      }
      return true;
    } catch {
      try { await unlink(tmp); } catch {}
      this.owned = false;
      return false;
    }
  }

  startHeartbeat(onLost = () => {}) {
    if (this._timer) return;
    this._timer = setInterval(async () => {
      const ok = await this.renew();
      if (!ok) {
        if (this._timer) {
          clearInterval(this._timer);
          this._timer = null;
        }
        onLost();
      }
    }, 4000);
    this._timer.unref?.();
  }

  async release() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (!this.owned || !this.leaseFile) {
      this.owned = false;
      return;
    }
    this.owned = false;
    try {
      const existing = await this._readLease();
      if (existing?.token === this.token) {
        await unlink(this.leaseFile);
      }
    } catch {}
  }
}
