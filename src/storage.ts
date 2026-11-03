import { constants, openSync, closeSync, fchownSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { Paths, SYSTEM_BASE, userDataRoot, atomicWrite, checked, exists, optionalRead, restoreFile, run, withLock } from './system';
import { Service, errorMessage, plist } from './service';

export type Owner = { uid: number; gid: number };
export type Registration = Owner & { version: number; base: string };

export async function readRegistration(systemBase = SYSTEM_BASE): Promise<Registration | undefined> {
  let data: Buffer | undefined;
  try { data = await optionalRead(join(systemBase, 'owner.json')); }
  catch (error) {
    // The legacy system directory was private to root.
    if ((error as NodeJS.ErrnoException).code === 'EACCES') return;
    throw error;
  }
  if (!data) return;
  const record = JSON.parse(data.toString()) as Registration;
  if (record.version !== 1 || !Number.isSafeInteger(record.uid) || record.uid < 0 || !Number.isSafeInteger(record.gid) || record.gid < 0 || typeof record.base !== 'string' || !isAbsolute(record.base) || record.base === systemBase) throw new Error('Invalid sbm service owner record.');
  return record;
}

export async function invokingOwner(): Promise<Owner & { home: string }> {
  let home = homedir(), uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;
  if (uid === 0 && process.env.SUDO_USER && process.env.SUDO_UID && process.env.SUDO_GID) {
    if (!/^\d+$/.test(process.env.SUDO_UID) || !/^\d+$/.test(process.env.SUDO_GID)) throw new Error('Invalid sudo user identity.');
    uid = Number(process.env.SUDO_UID); gid = Number(process.env.SUDO_GID);
    const output = await checked(run, ['/usr/bin/dscl', '.', '-read', `/Users/${process.env.SUDO_USER}`, 'NFSHomeDirectory']);
    const match = output.match(/^NFSHomeDirectory: (.+)$/m);
    if (!match || !isAbsolute(match[1])) throw new Error('Cannot determine the invoking user\'s home directory.');
    home = match[1];
  }
  return { home, uid, gid };
}

export async function managedStorage() {
  const owner = await invokingOwner();
  const record = await readRegistration();
  const paths = new Paths(record ? record.base : userDataRoot(owner.home), '/Library/LaunchDaemons', undefined, 'system', SYSTEM_BASE);
  return { paths, owner: record ? { uid: record.uid, gid: record.gid } : { uid: owner.uid, gid: owner.gid }, legacy: !record && await exists(SYSTEM_BASE) };
}

export function requireOwner(owner: Owner) {
  const uid = process.getuid?.() ?? 0;
  if (uid !== 0 && uid !== owner.uid) throw new Error(`This sbm instance belongs to user ID ${owner.uid}. Run configuration commands as that user.`);
}

// Root operations must not leave private files unreadable by the data owner.
// Open without following symlinks, and change ownership on that descriptor.
export async function restoreDataOwner(paths: Paths, owner: Owner): Promise<void> {
  async function visit(path: string) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (!info.isFile() && !info.isDirectory()) return;
    if (info.uid !== owner.uid || info.gid !== owner.gid) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { fchownSync(fd, owner.uid, owner.gid); }
      finally { closeSync(fd); }
    }
    if (info.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
  }
  await visit(paths.base);
}

export async function withDataLock<T>(paths: Paths, owner: Owner, action: () => Promise<T>): Promise<T> {
  return withLock(paths, async () => {
    try { return await action(); }
    finally { if (process.getuid?.() === 0) await restoreDataOwner(paths, owner); }
  });
}

export async function registerStorage(paths: Paths, owner: Owner): Promise<void> {
  const info = await lstat(paths.base);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed data must be a regular directory.');
  await mkdir(paths.systemBase, { recursive: true, mode: 0o755 });
  const systemInfo = await lstat(paths.systemBase);
  if (!systemInfo.isDirectory() || systemInfo.isSymbolicLink() || process.getuid?.() === 0 && systemInfo.uid !== 0) throw new Error('System service storage must be a root-owned directory.');
  await chmod(paths.systemBase, 0o755);
  const existing = await readRegistration(paths.systemBase);
  if (existing && (existing.base !== paths.base || existing.uid !== owner.uid || existing.gid !== owner.gid)) throw new Error('A different user already owns the system sbm instance.');
  await atomicWrite(paths.registration, JSON.stringify({ version: 1, uid: owner.uid, gid: owner.gid, base: paths.base }) + '\n', 0o644);
}

// Preserve JSON/JSONC formatting and comments; only replace complete string tokens.
export function relocateConfig(text: string, before: string, after: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"/g, token => {
    let value: string;
    try { value = JSON.parse(token) as string; } catch { return token; }
    return value === before || value.startsWith(before + '/') ? JSON.stringify(after + value.slice(before.length)) : token;
  });
}

// A one-time, privileged migration. Both old and new command locks are held;
// config, binary, logs and caches move together while the old service is paused.
export async function migrateStorage(service: Service, owner: Owner): Promise<void> {
  const paths = service.paths;
  if (await readRegistration(paths.systemBase)) return;
  const legacy = new Paths(paths.systemBase, paths.bootDir, paths.label, paths.domain);
  await mkdir(legacy.base, { recursive: true, mode: 0o700 });
  const legacyInfo = await lstat(legacy.base);
  if (!legacyInfo.isDirectory() || legacyInfo.isSymbolicLink()) throw new Error('Legacy storage must be a regular directory.');
  const legacyService = new Service(legacy, service.runner, service.timing);
  await withLock(legacy, async () => {
    if (await readRegistration(paths.systemBase)) return;
    const names = (await readdir(legacy.base)).filter(name => !['.lock', 'service.plist', 'owner.json'].includes(name));
    await mkdir(paths.base, { recursive: true, mode: 0o700 });
    for (const name of names) if (await exists(join(paths.base, name))) throw new Error(`Migration destination already exists: ${join(paths.base, name)}. Existing files were not replaced.`);
    await withLock(paths, async () => {
      const before = await legacyService.state();
      const oldPlist = await optionalRead(legacy.plist), oldBoot = await optionalRead(paths.bootPlist);
      const originals = new Map<string, Buffer>();
      const moved: string[] = [];
      try {
        if (before.loaded) await legacyService.pause();
        for (const name of names) { await rename(join(legacy.base, name), join(paths.base, name)); moved.push(name); }
        for (const name of ['config.json', 'config.json.previous']) {
          const path = join(paths.base, name), data = await optionalRead(path);
          if (!data) continue;
          const updated = relocateConfig(data.toString(), legacy.base, paths.base);
          if (updated !== data.toString()) { originals.set(path, data); await atomicWrite(path, updated); }
        }
        await paths.prepare();
        if (await exists(paths.config)) await service.validate();
        if (oldBoot) await atomicWrite(paths.bootPlist, plist(paths), 0o644);
        await atomicWrite(paths.plist, plist(paths));
        if (before.loaded) await service.launch();
        await restoreDataOwner(paths, owner);
        await registerStorage(paths, owner);
      } catch (error) {
        try {
          if (before.loaded) await service.pause();
          for (const [path, data] of originals) await atomicWrite(path, data);
          // prepare() may create empty bin/logs directories on an incomplete install.
          for (const name of moved.reverse()) await rename(join(paths.base, name), join(legacy.base, name));
          await restoreFile(legacy.plist, oldPlist);
          await restoreFile(paths.bootPlist, oldBoot, 0o644);
          await chmod(legacy.base, legacyInfo.mode & 0o777);
          if (before.loaded) await legacyService.launch();
        } catch (rollback) { throw new Error(`${errorMessage(error)} Migration rollback failed: ${errorMessage(rollback)}`); }
        throw new Error(`${errorMessage(error)} Previous storage and service state restored.`);
      }
    });
  });
}
