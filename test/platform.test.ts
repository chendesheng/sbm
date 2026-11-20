import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Paths, exists, type Result, type Runner } from '../src/system';
import { Service } from '../src/service';
import { WindowsUserHost } from '../src/hosts/windows';
import { activatePreparedInstall, selectAsset, withPreparedInstall } from '../src/install';
import type { Downloader } from '../src/download';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const ok = (stdout = ''): Result => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): Result => ({ code: 1, stdout: '', stderr });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sbm-windows-')); roots.push(root);
  const paths = Paths.windows(join(root, 'Local/sbm'), join(root, 'Roaming/Startup'));
  const calls: string[][] = [];
  let alive = false;
  const runner: Runner = async args => {
    calls.push(args);
    if (args[0] === 'tasklist') {
      return alive
        ? ok('"sing-box.exe","4242","Console","1","1,000 K"\n')
        : ok('INFO: No tasks are running which match the specified criteria.\n');
    }
    if (args[0] === 'taskkill') { alive = false; return ok(); }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  return { root, paths, calls, runner, get alive() { return alive; }, set alive(value: boolean) { alive = value; } };
}

test('windows layout keeps all managed state in the user directory', () => {
  const paths = Paths.windows('/Users/example/AppData/Local/sbm', '/Users/example/AppData/Roaming/Startup');
  expect(paths.kind).toBe('windows');
  expect(paths.systemBase).toBe(paths.base);
  expect(paths.core).toBe(join(paths.base, 'bin', 'sing-box.exe'));
  expect(paths.runState).toBe(join(paths.base, 'run.json'));
  expect(paths.plist).toBe(join(paths.base, 'service.json'));
  expect(paths.bootPlist).toBe(join(paths.bootDir, 'sbm-sing-box.vbs'));
});

test('macOS paths keep their launchd layout', () => {
  const paths = Paths.macos('/tmp/sbm-data', '/tmp/sbm-boot');
  expect(paths.kind).toBe('macos');
  expect(paths.core).toBe(join('/tmp/sbm-data', 'bin', 'sing-box'));
  expect(paths.plist).toBe(join('/tmp/sbm-data', 'service.plist'));
  expect(paths.bootPlist).toBe(join('/tmp/sbm-boot', 'io.github.chendesheng.sbm.sing-box.plist'));
});

test('windows host tracks the detached core through its pid file', async () => {
  const f = await fixture();
  const host = new WindowsUserHost(f.paths, f.runner, async () => 4242);
  expect(await host.state()).toEqual({ loaded: false, state: 'paused' });
  await host.start();
  expect(await readFile(f.paths.runState, 'utf8')).toBe('{"pid":4242,"image":"sing-box.exe"}\n');
  f.alive = true;
  expect(await host.state()).toEqual({ loaded: true, pid: 4242, state: 'running' });
  await host.stop();
  expect(await host.state()).toEqual({ loaded: false, state: 'paused' });
  expect(await exists(f.paths.runState)).toBe(false);
  expect(f.calls.some(args => args[0] === 'taskkill' && args.includes('4242'))).toBe(true);
});

test('windows host discards a pid file whose process is gone', async () => {
  const f = await fixture();
  await f.paths.prepare();
  await writeFile(f.paths.runState, '{"pid":7,"image":"sing-box.exe"}\n');
  const host = new WindowsUserHost(f.paths, f.runner, async () => 1);
  expect(await host.state()).toEqual({ loaded: false, state: 'paused' });
  expect(await exists(f.paths.runState)).toBe(false);
});

test('windows login startup is a hidden __run launcher in the Startup folder', async () => {
  const f = await fixture();
  const host = new WindowsUserHost(f.paths, f.runner, async () => 1);
  expect(await host.bootEnabled()).toBe(false);
  await host.enableBoot();
  const script = await readFile(f.paths.bootPlist, 'utf8');
  expect(script).toContain('WScript.Shell');
  expect(script).toContain('__run');
  expect(await host.bootEnabled()).toBe(true);
  await host.disableBoot();
  expect(await host.bootEnabled()).toBe(false);
});

test('Service selects the Windows host for a Windows layout', async () => {
  const f = await fixture();
  await f.paths.prepare();
  await writeFile(f.paths.runState, '{"pid":4242,"image":"sing-box.exe"}\n');
  f.alive = true;
  const service = new Service(f.paths, f.runner, { attempts: 2, interval: 1, stableSamples: 1 });
  expect(await service.state()).toEqual({ loaded: true, pid: 4242, state: 'running' });
  expect(await service.bootEnabled()).toBe(false);
  expect(f.calls.some(args => args[0] === '/bin/launchctl')).toBe(false);
});

test('windows host surfaces tasklist failures instead of reporting a stopped core', async () => {
  const f = await fixture();
  await f.paths.prepare();
  await writeFile(f.paths.runState, '{"pid":4242,"image":"sing-box.exe"}\n');
  const host = new WindowsUserHost(f.paths, async () => fail('Access is denied.'), async () => 1);
  await expect(host.state()).rejects.toThrow('Cannot read process state');
});

test('selects the Windows zip release and its executable', () => {
  const folder = 'sing-box-1.1.0-windows-amd64';
  const release = {
    tag_name: 'v1.1.0', draft: false, prerelease: false,
    assets: [{
      name: `${folder}.zip`, digest: `sha256:${'a'.repeat(64)}`,
      browser_download_url: `https://github.com/SagerNet/sing-box/releases/download/v1.1.0/${folder}.zip`,
    }],
  };
  const selected = selectAsset(release, 'x64', 'windows');
  expect(selected.folder).toBe(folder);
  expect(selected.binary).toBe('sing-box.exe');
  expect(() => selectAsset(release, 'x64', 'macos')).toThrow('macOS archive');
});

test('windows preparation extracts the zip with tar.exe and verifies the .exe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sbm-win-install-')); roots.push(root);
  const folder = 'sing-box-1.1.0-windows-amd64';
  const bytes = new TextEncoder().encode('windows archive bytes');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const metadata = {
    tag_name: 'v1.1.0', draft: false, prerelease: false,
    assets: [{
      name: `${folder}.zip`, digest,
      browser_download_url: `https://github.com/SagerNet/sing-box/releases/download/v1.1.0/${folder}.zip`,
    }],
  };
  const calls: string[][] = [];
  const runner: Runner = async args => {
    calls.push(args);
    if (args[0] === 'tar.exe') {
      const destination = args[args.indexOf('-C') + 1];
      const file = join(destination, ...args[args.length - 1].split('/'));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, '1.1.0');
      return ok();
    }
    if (args[1] === 'version') return ok(`sing-box version ${(await readFile(args[0], 'utf8')).trim()}\n`);
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  const fetcher = async () => Response.json(metadata);
  const downloader: Downloader = async (_url, destination) => { await writeFile(destination, bytes); };
  await withPreparedInstall(undefined, async () => {}, fetcher, 'x64', downloader, runner, join(root, 'cache'), {}, 'windows');
  const extract = calls.find(args => args[0] === 'tar.exe');
  expect(extract?.[1]).toBe('-xf');
  expect(extract?.[extract.length - 1]).toBe(`${folder}/sing-box.exe`);
  expect(calls.some(args => args[1] === 'version' && args[0].endsWith('sing-box.exe'))).toBe(true);
  expect(await exists(join(root, 'cache', folder))).toBe(true);
});

test('windows activation replaces a stopped core without authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sbm-win-activate-')); roots.push(root);
  const paths = Paths.windows(join(root, 'data'), join(root, 'startup'));
  const folder = 'sing-box-1.1.0-windows-amd64';
  const bytes = new TextEncoder().encode('windows archive bytes');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const metadata = {
    tag_name: 'v1.1.0', draft: false, prerelease: false,
    assets: [{
      name: `${folder}.zip`, digest,
      browser_download_url: `https://github.com/SagerNet/sing-box/releases/download/v1.1.0/${folder}.zip`,
    }],
  };
  const prepared = join(root, 'prepared'); await mkdir(prepared);
  await writeFile(join(prepared, 'release.json'), JSON.stringify(metadata));
  await writeFile(join(prepared, 'release.tar.gz'), bytes);
  const runner: Runner = async args => {
    if (args[0] === 'tar.exe') {
      const destination = args[args.indexOf('-C') + 1];
      const file = join(destination, ...args[args.length - 1].split('/'));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, '1.1.0');
      return ok();
    }
    if (args[1] === 'version') return ok(`sing-box version ${(await readFile(args[0], 'utf8')).trim()}\n`);
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  const service = new Service(paths, runner, { attempts: 2, interval: 1, stableSamples: 1 });
  expect(await activatePreparedInstall(service, prepared, 'x64')).toContain('sing-box 1.1.0 installed');
  expect(await readFile(paths.core, 'utf8')).toBe('1.1.0');
  expect(paths.core.endsWith('sing-box.exe')).toBe(true);
});
