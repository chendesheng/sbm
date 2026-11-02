import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Paths, type Runner, type Result, run, exists, withLock } from '../src/system';
import { Service, plist } from '../src/service';
import { parseArgs } from '../src/args';
import { install, releaseEndpoint, selectAsset, withPreparedInstall, activatePreparedInstall, type Fetcher } from '../src/install';
import type { Downloader } from '../src/download';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const ok = (stdout = ''): Result => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): Result => ({ code: 1, stdout: '', stderr });

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'sbm-test-')); directories.push(base);
  const paths = new Paths(join(base, 'app & data'), join(base, 'boot'));
  await paths.prepare();
  const calls: string[][] = [];
  let loaded = false, pid = 0, launches = 0, rejectLaunches = 0;
  let rejectCheck = false;
  const runner: Runner = async (args) => {
    calls.push(args);
    if (args[0] === '/bin/launchctl') {
      if (args[1] === 'print') return loaded ? ok(`state = running\npid = ${pid}\n`) : fail('Could not find service');
      if (args[1] === 'bootout') { loaded = false; return ok(); }
      if (args[1] === 'bootstrap') {
        launches++;
        if (rejectLaunches > 0) { rejectLaunches--; return fail('simulated launch failure'); }
        loaded = true; pid = 100 + launches; return ok();
      }
      return ok();
    }
    if (args[0] === '/usr/bin/tar') return run(args);
    if (args[1] === 'version') return ok(`sing-box version ${(await readFile(args[0], 'utf8')).trim()}\n`);
    if (args[1] === 'check') return rejectCheck ? fail('invalid config') : ok();
    throw new Error(`Unexpected command: ${args}`);
  };
  const service = new Service(paths, runner, { attempts: 4, interval: 1, stableSamples: 1 });
  await writeFile(paths.core, '1.0.0', { mode: 0o755 });
  await writeFile(paths.config, '{"old":true}', { mode: 0o600 });
  return { base, paths, service, calls, get launches() { return launches; }, set rejectLaunches(n: number) { rejectLaunches = n; }, set rejectCheck(b: boolean) { rejectCheck = b; } };
}
async function releaseFixture(f: Awaited<ReturnType<typeof fixture>>, version = '1.1.0') {
  const folder = `sing-box-${version}-darwin-arm64`;
  const archiveRoot = join(f.base, 'archive');
  await mkdir(join(archiveRoot, folder), { recursive: true });
  await writeFile(join(archiveRoot, folder, 'sing-box'), version);
  const archive = join(f.base, 'fixture.tar.gz');
  const result = await run(['/usr/bin/tar', '-czf', archive, '-C', archiveRoot, folder]);
  expect(result.code).toBe(0);
  const bytes = await readFile(archive);
  const metadata = { tag_name: `v${version}`, draft: false, prerelease: false, assets: [{
    name: `${folder}.tar.gz`, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    browser_download_url: `https://github.com/SagerNet/sing-box/releases/download/v${version}/${folder}.tar.gz`,
  }] };
  const fetcher: Fetcher = async () => Response.json(metadata);
  const downloader: Downloader = async (_url, destination) => { await writeFile(destination, bytes); };
  return { metadata, fetcher, downloader, bytes };
}
describe('arguments', () => {
  test('upgrade is exactly the install alias', () => {
    expect(parseArgs(['upgrade', '--version', '1.14.4'])).toEqual(parseArgs(['install', '--version', '1.14.4']));
  });
  test('rejects removed and malformed commands', () => {
    for (const args of [['stop'], ['logs'], ['start', '--config'], ['pause', '--config', 'a'], ['install', '--config', 'a']]) expect(() => parseArgs(args)).toThrow();
    expect(parseArgs(['start'])).toEqual({ command: 'start', value: undefined });
  });
});
describe('service', () => {
  test('start never installs a missing core', async () => {
    const f = await fixture(); await rm(f.paths.core);
    await expect(f.service.start()).rejects.toThrow('sbm install'); expect(f.calls).toEqual([]);
  });
  test('requires the first configuration', async () => {
    const f = await fixture(); await rm(f.paths.config);
    await expect(f.service.start()).rejects.toThrow('--config'); expect(f.launches).toBe(0);
  });
  test('repeated start and pause do not duplicate launches; boot setting survives', async () => {
    const f = await fixture();
    await f.service.enable(); expect((await f.service.state()).loaded).toBe(false);
    await f.service.start(); expect(await f.service.start()).toContain('already running'); expect(f.launches).toBe(1);
    await f.service.pause(); await f.service.pause(); expect(await exists(f.paths.bootPlist)).toBe(true);
    await f.service.start(); await f.service.disable(); expect((await f.service.state()).pid).toBeDefined();
    expect(await exists(f.paths.bootPlist)).toBe(false);
  });
  test('invalid new configuration leaves running service and saved config untouched', async () => {
    const f = await fixture(); await f.service.start();
    const input = join(f.base, 'input.json'); await writeFile(input, '{}'); f.rejectCheck = true;
    await expect(f.service.start(input)).rejects.toThrow('invalid config');
    expect(f.launches).toBe(1); expect((await f.service.state()).pid).toBeDefined();
    expect(await readFile(f.paths.config, 'utf8')).toBe('{"old":true}');
  });
  test('different configuration is copied with protected permissions; source remains untouched', async () => {
    const f = await fixture(); await f.service.start();
    const input = join(f.base, 'input.json'); await writeFile(input, '{"new":true}');
    await f.service.start(input);
    expect(f.launches).toBe(2); expect(await readFile(f.paths.config, 'utf8')).toBe('{"new":true}');
    expect(await readFile(input, 'utf8')).toBe('{"new":true}');
    expect(await readFile(`${f.paths.config}.previous`, 'utf8')).toBe('{"old":true}');
    expect((await stat(f.paths.config)).mode & 0o777).toBe(0o600);
  });
  test('failed replacement restores config and previous running state', async () => {
    const f = await fixture(); await f.service.start(); f.rejectLaunches = 1;
    const input = join(f.base, 'input.json'); await writeFile(input, '{}');
    await expect(f.service.start(input)).rejects.toThrow('restored');
    expect(await readFile(f.paths.config, 'utf8')).toBe('{"old":true}'); expect((await f.service.state()).pid).toBeDefined();
  });
  test('does not hide launchctl permission errors as paused', async () => {
    const f = await fixture(); const service = new Service(f.paths, async () => fail('Operation not permitted'));
    await expect(service.state()).rejects.toThrow('Cannot read');
  });
  test('startup timeout reports an unhealthy service', async () => {
    const f = await fixture();
    const runner: Runner = async args => args[1] === 'print' ? ok('state = waiting\n') : f.service.runner(args);
    const service = new Service(f.paths, runner, { attempts: 2, interval: 1, stableSamples: 1 });
    await expect(service.launch()).rejects.toThrow('did not remain running');
  });
  test('reports an explicitly configured core log path', async () => {
    const f = await fixture();
    await writeFile(f.paths.config, '{"log":{"output":"logs/core.log"}}');
    expect(await f.service.configuredLogPath()).toBe(join(f.paths.base, 'logs/core.log'));
  });
  test('plist quotes paths and launches the core directly', async () => {
    const f = await fixture(); const xml = plist(f.paths);
    expect(xml).toContain('app &amp; data'); expect(xml).toContain('<string>run</string>'); expect(xml).not.toContain('cli.ts');
  });
});
describe('installation', () => {
  test('reuses the verified cache after a cancelled administrator request', async () => {
    const f = await fixture(); const release = await releaseFixture(f); let downloads = 0;
    const downloader: Downloader = async (url, destination) => { downloads++; await release.downloader(url, destination); };
    const prepare = (code: number) => withPreparedInstall(undefined, async () => code, release.fetcher, 'arm64', downloader, f.service.runner, join(f.base, 'cache'));
    expect(await prepare(1)).toBe(1);
    expect(await prepare(0)).toBe(0);
    expect(downloads).toBe(1);
  });
  test('corrupt cached archives are downloaded again and repaired', async () => {
    const f = await fixture(); const release = await releaseFixture(f); let downloads = 0;
    const cache = join(f.base, 'cache');
    const downloader: Downloader = async (url, destination) => { downloads++; await release.downloader(url, destination); };
    const prepare = () => withPreparedInstall(undefined, async () => {}, release.fetcher, 'arm64', downloader, f.service.runner, cache);
    await prepare();
    const cached = join(cache, 'sing-box-1.1.0-darwin-arm64', `${release.metadata.assets[0].digest.slice(7)}.tar.gz`);
    await writeFile(cached, 'corrupt');
    await prepare();
    expect(downloads).toBe(2); expect(await readFile(cached)).toEqual(release.bytes);
  });
  test('a different release downloads its own archive', async () => {
    const f = await fixture(); const first = await releaseFixture(f); const second = await releaseFixture(f, '1.2.0');
    let downloads = 0;
    for (const release of [first, second]) {
      const downloader: Downloader = async (url, destination) => { downloads++; await release.downloader(url, destination); };
      await withPreparedInstall(undefined, async () => {}, release.fetcher, 'arm64', downloader, f.service.runner, join(f.base, 'cache'));
    }
    expect(downloads).toBe(2);
  });
  test('downloads and verifies before privileged handoff; cancellation cleans up', async () => {
    const f = await fixture(); const release = await releaseFixture(f);
    const events: string[] = []; let directory = '';
    const downloader: Downloader = async (url, destination) => {
      events.push('download'); await release.downloader(url, destination);
    };
    const code = await withPreparedInstall(undefined, async stage => {
      directory = stage; events.push('sudo');
      expect(await exists(join(stage, 'release.json'))).toBe(true);
      expect(f.calls.some(args => args[1] === 'version' && args[0].startsWith(stage))).toBe(true);
      expect(await readFile(f.paths.core, 'utf8')).toBe('1.0.0');
      return 1; // sudo cancelled, so activation never runs
    }, release.fetcher, 'arm64', downloader, f.service.runner, join(f.base, 'cache'));
    expect(code).toBe(1); expect(events).toEqual(['download', 'sudo']);
    expect(await exists(directory)).toBe(false);
    expect(await f.service.version()).toBe('1.0.0'); expect(f.launches).toBe(0);
  });
  test('failed verification never requests elevation', async () => {
    const f = await fixture(); const release = await releaseFixture(f); let elevated = false;
    const corrupt: Downloader = async (_url, destination) => { await writeFile(destination, 'corrupt'); };
    await expect(withPreparedInstall(undefined, async () => { elevated = true; }, release.fetcher, 'arm64', corrupt, f.service.runner, join(f.base, 'cache'))).rejects.toThrow('SHA-256 mismatch');
    expect(elevated).toBe(false); expect(await f.service.version()).toBe('1.0.0');
  });
  test('activation rechecks the downloaded bytes before changing the core', async () => {
    const f = await fixture(); const release = await releaseFixture(f);
    await expect(withPreparedInstall(undefined, async directory => {
      await writeFile(join(directory, 'release.tar.gz'), 'changed after verification');
      return activatePreparedInstall(f.service, directory, 'arm64');
    }, release.fetcher, 'arm64', release.downloader, f.service.runner, join(f.base, 'cache'))).rejects.toThrow('SHA-256 mismatch');
    expect(await f.service.version()).toBe('1.0.0'); expect(f.launches).toBe(0);
  });
  test('selects architecture and refuses unverified releases', () => {
    expect(releaseEndpoint()).toEndWith('/latest'); expect(releaseEndpoint('1.14.4')).toEndWith('/tags/v1.14.4');
    expect(() => releaseEndpoint('../../a')).toThrow();
    expect(() => selectAsset({ tag_name: 'v1.0.0', draft: false, prerelease: false, assets: [] }, 'ia32')).toThrow('architecture');
  });
  test('fresh install succeeds without a saved configuration or starting a service', async () => {
    const f = await fixture(); await rm(f.paths.core); await rm(f.paths.config); const release = await releaseFixture(f);
    await install(f.service, undefined, release.fetcher, 'arm64', release.downloader, join(f.base, 'cache'));
    expect(await f.service.version()).toBe('1.1.0'); expect(f.launches).toBe(0);
  });
  test('upgrading a paused service stays paused and repeat install is a no-op', async () => {
    const f = await fixture(); const release = await releaseFixture(f);
    await install(f.service, undefined, release.fetcher, 'arm64', release.downloader, join(f.base, 'cache'));
    expect(await f.service.version()).toBe('1.1.0'); expect(f.launches).toBe(0);
    expect(await install(f.service, undefined, release.fetcher, 'arm64', release.downloader, join(f.base, 'cache'))).toContain('already installed');
  });
  test('running upgrade validates first and restarts', async () => {
    const f = await fixture(); await f.service.start(); const release = await releaseFixture(f);
    await install(f.service, '1.1.0', release.fetcher, 'arm64', release.downloader, join(f.base, 'cache'));
    expect(await f.service.version()).toBe('1.1.0'); expect(f.launches).toBe(2);
  });
  test('failed upgrade startup rolls the binary and running state back', async () => {
    const f = await fixture(); await f.service.start(); f.rejectLaunches = 1; const release = await releaseFixture(f);
    await expect(install(f.service, undefined, release.fetcher, 'arm64', release.downloader, join(f.base, 'cache'))).rejects.toThrow('restored');
    expect(await f.service.version()).toBe('1.0.0'); expect((await f.service.state()).pid).toBeDefined();
  });
  test('incompatible upgrade leaves running binary untouched', async () => {
    const f = await fixture(); await f.service.start(); f.rejectCheck = true; const release = await releaseFixture(f);
    await expect(install(f.service, undefined, release.fetcher, 'arm64', release.downloader, join(f.base, 'cache'))).rejects.toThrow('invalid config');
    expect(await f.service.version()).toBe('1.0.0'); expect(f.launches).toBe(1);
  });
  test('checksum mismatch and HTTP failures preserve the installation', async () => {
    const f = await fixture(); const release = await releaseFixture(f);
    const corrupt: Downloader = async (_url, destination) => { await writeFile(destination, 'truncated download'); };
    await expect(install(f.service, undefined, release.fetcher, 'arm64', corrupt, join(f.base, 'cache'))).rejects.toThrow('SHA-256 mismatch');
    const missing: Fetcher = async () => new Response('rate limited', { status: 429 });
    await expect(install(f.service, undefined, missing, 'arm64')).rejects.toThrow('HTTP 429');
    expect(await f.service.version()).toBe('1.0.0');
  });
  test('missing published digest is rejected', async () => {
    const f = await fixture(); const release = await releaseFixture(f); release.metadata.assets[0].digest = '';
    await expect(install(f.service, undefined, release.fetcher, 'arm64', release.downloader, join(f.base, 'cache'))).rejects.toThrow('no published');
  });
  test('interrupted download leaves the installed core intact', async () => {
    const f = await fixture(); const release = await releaseFixture(f);
    const interrupted: Downloader = async () => { throw new Error('curl download failed (exit 18).'); };
    await expect(install(f.service, undefined, release.fetcher, 'arm64', interrupted, join(f.base, 'cache'))).rejects.toThrow('curl download failed');
    expect(await f.service.version()).toBe('1.0.0');
  });
});
test('concurrent mutations are serialized and locks are released after failure', async () => {
  const f = await fixture(); const events: string[] = [];
  await Promise.all([
    withLock(f.paths, async () => { events.push('first'); await Bun.sleep(50); events.push('first done'); }),
    withLock(f.paths, async () => { events.push('second'); }),
  ]);
  expect(events).toEqual(['first', 'first done', 'second']);
  await expect(withLock(f.paths, async () => { throw new Error('failure'); })).rejects.toThrow('failure');
  expect(await exists(join(f.paths.base, '.lock'))).toBe(false);
});
