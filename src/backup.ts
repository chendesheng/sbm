import { createHash } from 'node:crypto';
import { open, readFile, readdir, lstat, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWrite, exists, optionalRead, restoreFile, type Paths } from './system';
import { Service, errorMessage } from './service';

const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_FILES = 1024;
type Entry = { path: string; member: string; size: number; sha256: string };
type Manifest = { format: 'sbm-config-backup'; version: 1; bootEnabled: boolean; files: Entry[] };
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const excluded = (path: string) => ['bin', 'logs', '.lock'].includes(path.split('/')[0]) || /^\.(backup|restore|install)-/.test(path.split('/')[0]) || ['service.plist', 'cache.db', 'cache.db-shm', 'cache.db-wal'].includes(path);
function validPath(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.includes('\\') && !path.split('/').some(x => !x || x === '.' || x === '..') && !excluded(path);
}
async function runBinary(argv: string[], cwd?: string, max = MAX_TOTAL): Promise<Buffer> {
  const child = Bun.spawn(argv, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const chunks: Uint8Array[] = []; let size = 0;
  const stderr = new Response(child.stderr).text();
  try {
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > max) { child.kill(); throw new Error('Archive output exceeds the size limit.'); }
      chunks.push(chunk);
    }
    const code = await child.exited;
    const err = await stderr;
    if (code !== 0) throw new Error(`${argv[0]} failed: ${err.trim() || `exit ${code}`}`);
    return Buffer.concat(chunks);
  } finally { await child.exited; await stderr; }
}
async function filesUnder(base: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string, prefix: string) {
    for (const item of await readdir(dir)) {
      const path = prefix ? `${prefix}/${item}` : item;
      if (excluded(path)) continue;
      if (!validPath(path)) throw new Error('Unsupported managed file path.');
      const info = await lstat(join(base, path));
      if (info.isSymbolicLink()) throw new Error(`Cannot back up symbolic link: ${path}`);
      if (info.isDirectory()) await walk(join(base, path), path);
      else if (info.isFile()) files.push(path);
      else throw new Error(`Unsupported managed file type: ${path}`);
      if (files.length > MAX_FILES) throw new Error('Too many managed files to back up.');
    }
  }
  await walk(base, '');
  return files.sort();
}
function localReferences(data: Buffer, base: string): string[] {
  let config: any;
  try { config = JSON.parse(data.toString()); } catch { throw new Error('Backup requires a plain JSON configuration.'); }
  const references: string[] = [];
  const walk = (obj: any) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { for (const x of obj) walk(x); return; }
    if (obj.type === 'local' && typeof obj.path === 'string') references.push(obj.path);
    for (const [key, value] of Object.entries(obj)) {
      if (/^(certificate_path|key_path|client_certificate_path|client_key_path|private_key_path|public_key_path)$/.test(key)) {
        if (typeof value === 'string') references.push(value);
        else if (Array.isArray(value)) for (const v of value) if (typeof v === 'string') references.push(v);
      }
      walk(value);
    }
  };
  walk(config);
  return references.map(path => {
    const rel = relative(base, resolve(base, path));
    if (!validPath(rel) || rel.startsWith(`..${sep}`)) throw new Error(`Referenced local asset is outside the managed configuration: ${path}`);
    return rel;
  });
}
async function safeParents(base: string, path: string) {
  let dir = base;
  for (const component of path.split('/').slice(0, -1)) {
    dir = join(dir, component);
    try { const s = await lstat(dir); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error(`Unsafe directory: ${dir}`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; await mkdir(dir, { mode: 0o700 }); }
  }
  const target = join(base, path);
  try { const s = await lstat(target); if (!s.isFile() || s.isSymbolicLink()) throw new Error(`Unsafe managed file: ${target}`); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
export async function backupConfig(paths: Paths, destination: string): Promise<string> {
  destination = resolve(destination);
  if (!relative(paths.base, destination).startsWith(`..${sep}`) && relative(paths.base, destination) !== '..') throw new Error('Backup file must be outside the managed directory.');
  const source = await readFile(paths.config);
  const references = localReferences(source, paths.base);
  const names = await filesUnder(paths.base);
  if (!names.includes('config.json')) throw new Error('No saved configuration.');
  for (const path of references) if (!names.includes(path)) throw new Error(`Referenced local asset is missing: ${path}`);
  const stage = await mkdtemp(join(paths.base, '.backup-'));
  try {
    await mkdir(join(stage, 'files'), { mode: 0o700 });
    const manifest: Manifest = { format: 'sbm-config-backup', version: 1, bootEnabled: await exists(paths.bootPlist), files: [] };
    let total = 0;
    for (const path of names) {
      if ((await lstat(join(paths.base, path))).size > MAX_FILE) throw new Error('Managed files exceed backup size limits.');
      const data = path === 'config.json' ? source : await readFile(join(paths.base, path));
      total += data.length;
      if (data.length > MAX_FILE || total > MAX_TOTAL) throw new Error('Managed files exceed backup size limits.');
      const member = `files/${String(manifest.files.length).padStart(6, '0')}`;
      await writeFile(join(stage, member), data, { mode: 0o600 });
      manifest.files.push({ path, member, size: data.length, sha256: digest(data) });
    }
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    await runBinary(['/usr/bin/zip', '-q', '-X', '-r', join(stage, 'backup.zip'), 'manifest.json', 'files'], stage);
    const data = await readFile(join(stage, 'backup.zip'));
    const file = await open(destination, 'wx', 0o600);
    try {
      await file.writeFile(data);
      const uid = process.env.SUDO_UID, gid = process.env.SUDO_GID;
      if (uid && gid && /^\d+$/.test(uid) && /^\d+$/.test(gid)) await file.chown(Number(uid), Number(gid));
    } catch (e) { await file.close(); await rm(destination, { force: true }); throw e; }
    await file.close();
    return `Configuration backup saved to ${destination}.`;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function restoreConfig(service: Service, archive: string): Promise<string> {
  const paths = service.paths;
  await service.requireCore();
  const zip = resolve(archive);
  const archiveStat = await stat(zip);
  if (!archiveStat.isFile()) throw new Error('Backup archive must be a regular file.');
  if (archiveStat.size > MAX_TOTAL) throw new Error('Backup archive exceeds the size limit.');
  const stage = await mkdtemp(join(paths.base, '.restore-'));
  try {
    // Snapshot the archive so it cannot change between validation and extraction.
    const snapshot = join(stage, 'backup.zip');
    const data = await readFile(zip);
    if (data.length > MAX_TOTAL) throw new Error('Backup archive exceeds the size limit.');
    await writeFile(snapshot, data, { mode: 0o600 });
    const listing = (await runBinary(['/usr/bin/unzip', '-Z1', snapshot], undefined, 256 * 1024)).toString().split('\n').filter(Boolean);
    if (listing.length > MAX_FILES + 2 || new Set(listing).size !== listing.length || listing.some(x => x !== 'manifest.json' && x !== 'files/' && !/^files\/\d{6}$/.test(x))) throw new Error('Invalid backup archive members.');
    const manifest = JSON.parse((await runBinary(['/usr/bin/unzip', '-p', snapshot, 'manifest.json'], undefined, 1024 * 1024)).toString()) as Manifest;
    if (manifest.format !== 'sbm-config-backup' || manifest.version !== 1 || typeof manifest.bootEnabled !== 'boolean' || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) throw new Error('Invalid backup manifest.');
    const contents = new Map<string, Buffer>(); let total = 0;
    for (const entry of manifest.files) {
      if (typeof entry.path !== 'string' || !validPath(entry.path) || !/^files\/\d{6}$/.test(entry.member) || !listing.includes(entry.member) || contents.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('Invalid backup manifest entry.');
      total += entry.size; if (total > MAX_TOTAL) throw new Error('Backup contents exceed the size limit.');
      const data = await runBinary(['/usr/bin/unzip', '-p', snapshot, entry.member], undefined, MAX_FILE);
      if (data.length !== entry.size || digest(data) !== entry.sha256) throw new Error('Backup file integrity check failed.');
      contents.set(entry.path, data);
    }
    if (!contents.has('config.json') || new Set(manifest.files.map(x => x.member)).size !== manifest.files.length || listing.filter(x => x.startsWith('files/') && x !== 'files/').length !== manifest.files.length) throw new Error('Incomplete backup archive.');
    for (const path of localReferences(contents.get('config.json')!, paths.base)) if (!contents.has(path)) throw new Error(`Referenced local asset is missing from backup: ${path}`);
    for (const [path] of contents) await safeParents(paths.base, path);
    const previous = new Map<string, Buffer | undefined>();
    for (const [path] of contents) previous.set(path, await optionalRead(join(paths.base, path)));
    const oldBoot = await optionalRead(paths.bootPlist);
    const before = await service.state();
    try {
      if (before.loaded) await service.pause();
      for (const [path, data] of contents) await atomicWrite(join(paths.base, path), data);
      await service.validate();
      if (manifest.bootEnabled) await service.enable(); else await service.disable();
      if (before.loaded) await service.launch();
    } catch (error) {
      try {
        await service.pause();
        for (const [path, data] of previous) await restoreFile(join(paths.base, path), data);
        await restoreFile(paths.bootPlist, oldBoot, 0o644);
        if (before.loaded) await service.launch();
      } catch (rollback) { throw new Error(`${errorMessage(error)} Rollback failed: ${errorMessage(rollback)}`); }
      throw new Error(`${errorMessage(error)} Previous configuration and service state restored.`);
    }
    return `Configuration restored from ${zip}. Service ${before.loaded ? 'restarted' : 'remains paused'}.`;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
