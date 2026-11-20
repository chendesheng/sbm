import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, chmod, open, writeFile, rename, rm, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { coreName, defaultBootDir, defaultSystemRoot, defaultUserRoot, hostPlatform, isWindows, runStateName, startupScriptName, type PlatformKind } from './platform';

export type Result = { code: number; stdout: string; stderr: string };
export type Runner = (args: string[]) => Promise<Result>;
export async function run(args: string[], timeout = 30_000): Promise<Result> {
  const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeout);
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); });
  try {
    const code = await exited;
    return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  } finally { clearTimeout(timer); }
}
export function selfInvocation(): string[] {
  // ScriptC supplies a synthetic argv[0]; source execution needs its entry file.
  return process.argv[0] === 'scriptc' ? [process.execPath] : [process.execPath, process.argv[1]];
}
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
export const SYSTEM_BASE = defaultSystemRoot('macos');
export const userDataRoot = (home = homedir()) => join(home, 'Library/Application Support/sbm');
export class Paths {
  readonly base: string;
  readonly bootDir: string;
  readonly label: string;
  readonly domain: string;
  readonly systemBase: string;
  readonly kind: PlatformKind;
  constructor(base = defaultUserRoot(), bootDir = defaultBootDir(), label = LABEL, domain = 'system', systemBase?: string, kind: PlatformKind = hostPlatform) {
    this.base = base;
    this.bootDir = bootDir;
    this.label = label;
    this.domain = domain;
    this.kind = kind;
    this.systemBase = systemBase ?? (isWindows(kind) ? base : base === userDataRoot() && domain === 'system' ? SYSTEM_BASE : base);
  }
  // Windows keeps every managed file in the per-user directory and registers
  // login startup in the user's Startup folder instead of launchd.
  static windows(base: string, bootDir: string, label = LABEL): Paths {
    return new Paths(base, bootDir, label, 'user', base, 'windows');
  }
  static macos(base: string, bootDir: string, label = LABEL): Paths {
    return new Paths(base, bootDir, label, 'system', base, 'macos');
  }
  get core() { return join(this.base, 'bin', coreName(this.kind)); }
  get config() { return join(this.base, 'config.json'); }
  get plist() { return join(this.systemBase, isWindows(this.kind) ? 'service.json' : 'service.plist'); }
  get registration() { return join(this.systemBase, 'owner.json'); }
  get bootPlist() { return join(this.bootDir, isWindows(this.kind) ? startupScriptName() : `${this.label}.plist`); }
  get runState() { return join(this.base, runStateName()); }
  get stdout() { return join(this.base, 'logs/stdout.log'); }
  get stderr() { return join(this.base, 'logs/stderr.log'); }
  get target() { return `${this.domain}/${this.label}`; }
  async prepare() {
    await mkdir(this.base, { recursive: true, mode: 0o700 });
    if (!isWindows(this.kind)) await chmod(this.base, 0o700);
    await mkdir(join(this.base, 'bin'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.base, 'logs'), { recursive: true, mode: 0o700 });
    for (const file of [this.stdout, this.stderr]) {
      const handle = await open(file, 'a', 0o600);
      await handle.close();
      if (!isWindows(this.kind)) await chmod(file, 0o600);
    }
  }
}
export async function atomicWrite(path: string, value: string | Uint8Array, mode = 0o600) {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeNewFile(temp, value, mode);
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
// Keep exclusive creation and binary writes on the same descriptor.
export async function writeNewFile(path: string, value: string | Uint8Array, mode = 0o600) {
  const file = await open(path, 'wx', mode);
  try {
    // ScriptC requires a concrete input type for each writeFile call.
    if (typeof value === 'string') await file.writeFile(value);
    else await file.writeFile(value);
  } finally { await file.close(); }
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
      await sleep(100);
    }
  }
  try {
    await writeFile(join(lock, 'pid'), `${process.pid}\n`, { mode: 0o600 });
    return await action();
  } finally { await rm(lock, { recursive: true, force: true }); }
}
