import { mkdir, chmod, writeFile, rename, rm, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Result = { code: number; stdout: string; stderr: string };
export type Runner = (args: string[]) => Promise<Result>;
export const run: Runner = async (args) => {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 30_000 });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { code, stdout, stderr };
};
export async function checked(runner: Runner, args: string[]): Promise<string> {
  const result = await runner(args);
  if (result.code !== 0) throw new Error(`${args[0]} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}
export async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
export const LABEL = 'io.github.chendesheng.sbm.sing-box';
export class Paths {
  constructor(readonly base = '/Library/Application Support/sbm', readonly bootDir = '/Library/LaunchDaemons', readonly label = LABEL, readonly domain = 'system') {}
  get core() { return join(this.base, 'bin/sing-box'); }
  get config() { return join(this.base, 'config.json'); }
  get plist() { return join(this.base, 'service.plist'); }
  get bootPlist() { return join(this.bootDir, `${this.label}.plist`); }
  get stdout() { return join(this.base, 'logs/stdout.log'); }
  get stderr() { return join(this.base, 'logs/stderr.log'); }
  get target() { return `${this.domain}/${this.label}`; }
  async prepare() {
    await mkdir(this.base, { recursive: true, mode: 0o700 });
    await chmod(this.base, 0o700);
    await mkdir(join(this.base, 'bin'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.base, 'logs'), { recursive: true, mode: 0o700 });
    for (const file of [this.stdout, this.stderr]) {
      await writeFile(file, '', { flag: 'a', mode: 0o600 });
      await chmod(file, 0o600);
    }
  }
}
export async function atomicWrite(path: string, value: string | Uint8Array, mode = 0o600) {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, { mode, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
export async function restoreFile(path: string, old: Uint8Array | undefined, mode = 0o600) {
  if (old) await atomicWrite(path, old, mode);
  else await rm(path, { force: true });
}
export async function optionalRead(path: string): Promise<Buffer | undefined> {
  return await exists(path) ? readFile(path) : undefined;
}
export async function withLock<T>(paths: Paths, action: () => Promise<T>, timeout = 30_000): Promise<T> {
  const lock = join(paths.base, '.lock');
  const deadline = Date.now() + timeout;
  let announced = false;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (!announced) { console.log('Waiting for another sbm operation to finish...'); announced = true; }
      if (Date.now() >= deadline) throw new Error(`Another sbm operation holds ${lock}. If interrupted, confirm no sbm command is running before removing this directory.`);
      await Bun.sleep(100);
    }
  }
  try {
    await writeFile(join(lock, 'pid'), `${process.pid}\n`, { mode: 0o600 });
    return await action();
  } finally { await rm(lock, { recursive: true, force: true }); }
}
