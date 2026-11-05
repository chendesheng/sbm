import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppController, AuthorizationCancelled, newerVersion, type AppAction, type AppModel } from '../src/app/controller';
import { Service } from '../src/service';
import { Paths, run, withLock, type Runner } from '../src/system';
import type { Downloader } from '../src/download';
import type { Fetcher } from '../src/install';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture(running = false, latest = '1.1.0') {
  const root = await mkdtemp(join(tmpdir(), 'sbm-app-')); folders.push(root);
  const paths = new Paths(join(root, 'managed'), join(root, 'boot')); await paths.prepare();
  await writeFile(paths.core, '1.0.0'); await writeFile(paths.config, '{}');
  const folder = `sing-box-${latest}-darwin-arm64`;
  await mkdir(join(root, folder)); await writeFile(join(root, folder, 'sing-box'), latest);
  const archive = join(root, 'release.tar.gz');
  expect((await run(['/usr/bin/tar', '-czf', archive, '-C', root, folder])).code).toBe(0);
  const bytes = await readFile(archive);
  const release = { tag_name: `v${latest}`, draft: false, prerelease: false, assets: [{ name: `${folder}.tar.gz`, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, browser_download_url: `https://github.com/SagerNet/sing-box/releases/download/v${latest}/${folder}.tar.gz` }] };
  let active = running, rejectCandidate = false, downloads = 0;
  const calls: string[][] = [];
  const runner: Runner = async args => {
    calls.push(args);
    if (args[0] === '/bin/launchctl') {
      if (args[1] === 'print') return active ? { code: 0, stdout: 'state = running\npid = 101\n', stderr: '' } : { code: 1, stdout: '', stderr: 'Could not find service' };
      if (args[1] === 'bootout') active = false;
      if (args[1] === 'bootstrap') active = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[1] === 'version') return { code: 0, stdout: `sing-box version ${await readFile(args[0], 'utf8')}\n`, stderr: '' };
    if (args[1] === 'check') return { code: rejectCandidate && args[0] !== paths.core ? 1 : 0, stdout: '', stderr: 'incompatible config' };
    return run(args);
  };
  const states: AppModel[] = [], alerts: string[] = [], authorized: AppAction[] = [];
  const downloader: Downloader = async (_url, destination, options) => {
    downloads++;
    options?.onProgress?.({ receivedBytes: 0, totalBytes: bytes.length });
    await writeFile(destination, bytes);
    options?.onProgress?.({ receivedBytes: bytes.length, totalBytes: bytes.length });
  };
  const owner = { uid: process.getuid!(), gid: process.getgid!() };
  let checks = 0;
  let fetcher: Fetcher = async () => Response.json(release);
  const controller = new AppController(new Service(paths, runner, { attempts: 4, interval: 1, stableSamples: 1 }), owner,
    async action => {
      authorized.push(action);
      await withLock(paths, async () => {}, 100);
      if (action === 'upgrade') {
        expect(downloads).toBe(1);
        expect(states.some(state => state.upgradeLabel === 'Upgrading (100%)')).toBe(true);
        expect(calls.some(args => args[1] === 'check' && args[0].includes('/extracted/'))).toBe(true);
      }
      throw new AuthorizationCancelled();
    }, model => states.push({ ...model }), message => alerts.push(message), async url => { checks++; return fetcher(url); }, downloader, join(root, 'cache'), 'arm64');
  return { root, paths, controller, states, alerts, authorized, release, get checks() { return checks; }, set fetcher(value: Fetcher) { fetcher = value; }, get downloads() { return downloads; }, set active(value: boolean) { active = value; }, set rejectCandidate(value: boolean) { rejectCandidate = value; } };
}
test('each menu opening checks in the background and shows only the available upgrade', async () => {
  const f = await fixture(); await f.controller.refresh();
  let respond!: (response: Response) => void;
  f.fetcher = () => new Promise(resolve => { respond = resolve; });
  const checking = f.controller.checkForUpdates();
  expect(f.controller.model.upgradeLabel).toBe('');
  expect(f.controller.model.canUpgrade).toBe(false);
  expect(f.controller.model.busy).toBe(false);
  expect(f.controller.model.canStart).toBe(true);
  await f.controller.refresh();
  expect(f.controller.model.canUpgrade).toBe(false);
  respond(Response.json(f.release)); await checking;
  expect(f.controller.model.upgradeLabel).toBe('Upgrade to 1.1.0');
  expect(f.controller.model.canUpgrade).toBe(true);
  f.fetcher = async () => Response.json(f.release);
  await f.controller.checkForUpdates();
  expect(f.checks).toBe(2);
  await f.controller.upgrade();
  expect(f.checks).toBe(2);
  expect(f.controller.model.upgradeLabel).toBe('');
  expect(f.controller.model.canUpgrade).toBe(false);
});
test('equal/newer installed versions keep the update item hidden across status refresh; missing cores can be installed', async () => {
  const f = await fixture(false, '1.0.0'); await f.controller.refresh();
  await f.controller.checkForUpdates(); await f.controller.refresh();
  expect(f.controller.model.upgradeLabel).toBe('');
  expect(f.controller.model.canUpgrade).toBe(false);
  await writeFile(f.paths.core, '2.0.0'); await f.controller.checkForUpdates();
  expect(f.controller.model.upgradeLabel).toBe('');
  expect(f.controller.model.canUpgrade).toBe(false);
  await rm(f.paths.core); await f.controller.checkForUpdates();
  expect(f.controller.model.upgradeLabel).toBe('Upgrade to 1.0.0');
  expect(f.controller.model.canUpgrade).toBe(true);
  expect(f.downloads).toBe(0); expect(f.authorized).toEqual([]);
});
test('failed or invalid release checks keep the update item hidden and retry on the next opening without alerts', async () => {
  const f = await fixture(); await f.controller.refresh();
  await f.controller.checkForUpdates();
  for (const response of [new Response('', { status: 503 }), Response.json({ ...f.release, prerelease: true }), Response.json({ ...f.release, assets: [] }), new Response('invalid JSON')]) {
    f.fetcher = async () => response;
    await f.controller.checkForUpdates(); await f.controller.refresh();
    expect(f.controller.model.upgradeLabel).toBe('');
    expect(f.controller.model.canUpgrade).toBe(false);
  }
  f.fetcher = async () => Response.json(f.release);
  await f.controller.checkForUpdates();
  expect(f.controller.model.upgradeLabel).toBe('Upgrade to 1.1.0');
  expect(f.controller.model.canUpgrade).toBe(true);
  expect(f.alerts).toEqual([]); expect(f.downloads).toBe(0);
});
test('an earlier menu request cannot overwrite the newest response', async () => {
  const f = await fixture(); await f.controller.refresh();
  const responses: ((response: Response) => void)[] = [];
  f.fetcher = () => new Promise(resolve => { responses.push(resolve); });
  const earlier = f.controller.checkForUpdates(), latest = f.controller.checkForUpdates();
  responses[1](Response.json(f.release)); await latest;
  responses[0](new Response('', { status: 503 })); await earlier;
  expect(f.controller.model.upgradeLabel).toBe('Upgrade to 1.1.0');
  expect(f.controller.model.canUpgrade).toBe(true);
});
test('an unrecognized installed version hides updates without breaking periodic refresh', async () => {
  const f = await fixture(); await f.controller.refresh(); await f.controller.checkForUpdates();
  await writeFile(f.paths.core, 'development');
  await f.controller.refresh();
  expect(f.controller.model.upgradeLabel).toBe('');
  expect(f.controller.model.canUpgrade).toBe(false);
});
test('opening the menu during an operation checks without replacing its progress label', async () => {
  const f = await fixture(); await f.controller.refresh();
  f.controller.model.busy = true; f.controller.model.upgradeLabel = 'Upgrading (42%)';
  await f.controller.checkForUpdates();
  expect(f.checks).toBe(1);
  expect(f.controller.model.upgradeLabel).toBe('Upgrading (42%)');
  expect(f.controller.model.busy).toBe(true);
});
test('the installed version, service state, and stale Start/Pause actions need no authorization', async () => {
  const f = await fixture(true); await f.controller.refresh();
  expect(f.controller.model.status).toBe('running'); expect(f.controller.model.version).toBe('1.0.0');
  await f.controller.changeState('start');
  f.active = false;
  await f.controller.changeState('pause');
  expect(f.authorized).toEqual([]); expect(f.controller.model.status).toBe('paused');
});
test('a paused upgrade streams progress and replaces the core without authorization or starting it', async () => {
  const f = await fixture(); await f.controller.upgrade();
  expect(f.authorized).toEqual([]); expect(f.downloads).toBe(1);
  expect(await readFile(f.paths.core, 'utf8')).toBe('1.1.0');
  expect(f.controller.model.status).toBe('paused'); expect(f.controller.model.version).toBe('1.1.0');
  expect(f.states.some(state => state.busy && state.upgradeLabel === 'Upgrading (100%)')).toBe(true);
});
test('running upgrades authorize after download and candidate validation; cancellation preserves the core', async () => {
  const f = await fixture(true); await f.controller.upgrade();
  expect(f.authorized).toEqual(['upgrade']); expect(f.alerts).toEqual([]);
  expect(await readFile(f.paths.core, 'utf8')).toBe('1.0.0'); expect(f.controller.model.status).toBe('running');
  expect(f.controller.model.busy).toBe(false);
});
test('incompatible updates fail before asking for authorization or replacing the core', async () => {
  const f = await fixture(true); f.rejectCandidate = true; await f.controller.upgrade();
  expect(f.authorized).toEqual([]); expect(f.alerts.join()).toContain('incompatible config');
  expect(await readFile(f.paths.core, 'utf8')).toBe('1.0.0'); expect(f.controller.model.busy).toBe(false);
});
test('up-to-date installs do not download or authorize', async () => {
  const f = await fixture(true, '1.0.0'); await f.controller.upgrade();
  expect(f.downloads).toBe(0); expect(f.authorized).toEqual([]); expect(f.alerts).toEqual(['sing-box is already up to date.']);
});
test('Start validates before authorization, and cancellation leaves a paused service paused', async () => {
  const f = await fixture(); await f.controller.changeState('start');
  expect(f.authorized).toEqual(['start']); expect(f.controller.model.status).toBe('paused'); expect(f.alerts).toEqual([]);
});
test('version checks never downgrade a newer installed core', () => {
  expect(newerVersion('1.14.4', '1.15.0')).toBe(false);
  expect(newerVersion('1.14.4', '1.14.4')).toBe(false);
  expect(newerVersion('1.14.4', '1.14.4-beta.1')).toBe(true);
  expect(newerVersion('1.15.0', '1.14.4')).toBe(true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('service switch responds immediately and serializes rapid changes while the service is slow', async () => {
  const f = await fixture(true); await f.controller.refresh();
  const entered = deferred<void>(), finish = deferred<void>();
  const calls: string[] = [];
  f.controller.service.routingPauseReady = async () => true;
  // Keep the service loaded while routing is paused, as in the real fast path.
  let paused = false;
  f.controller.service.state = async () => ({ loaded: true, pid: 101, state: 'running' });
  f.controller.service.routingPaused = async () => paused;
  f.controller.service.pause = async () => { calls.push('pause'); entered.resolve(); await finish.promise; paused = true; };
  f.controller.service.start = async () => { calls.push('start'); paused = false; return ''; };
  const changing = f.controller.changeState('pause');
  expect(f.controller.model.switchOn).toBe(false);
  expect(f.controller.model.busy).toBe(false);
  expect(f.controller.model.canStart).toBe(true);
  await entered.promise;
  await f.controller.changeState('start');
  await f.controller.changeState('pause');
  await f.controller.changeState('start');
  await f.controller.refresh(); await f.controller.upgrade();
  expect(f.controller.model.switchOn).toBe(true);
  expect(calls).toEqual(['pause']); expect(f.downloads).toBe(0);
  finish.resolve(); await changing;
  expect(calls).toEqual(['pause', 'start']);
  expect(f.controller.model.status).toBe('running');
  expect(f.controller.model.switchOn).toBe(true);
  expect(f.controller.model.switchRevision).toBe(4);
});

test('a status read started before a click cannot move the switch back', async () => {
  const f = await fixture(true); await f.controller.refresh();
  const stale = deferred<{ loaded: boolean; pid: number; state: string }>();
  const entered = deferred<void>(), finish = deferred<void>();
  let reads = 0, paused = false;
  f.controller.service.state = () => ++reads === 1 ? stale.promise : Promise.resolve({ loaded: true, pid: 101, state: 'running' });
  f.controller.service.routingPaused = async () => paused;
  f.controller.service.routingPauseReady = async () => true;
  f.controller.service.pause = async () => { entered.resolve(); await finish.promise; paused = true; };
  const reading = f.controller.refresh();
  const changing = f.controller.changeState('pause'); await entered.promise;
  stale.resolve({ loaded: true, pid: 101, state: 'running' }); await reading;
  expect(f.controller.model.switchOn).toBe(false);
  finish.resolve(); await changing;
  expect(f.controller.model.switchOn).toBe(false);
  expect(f.controller.model.status).toBe('paused');
});

test('a failed switch restores observed service state and remains usable', async () => {
  const f = await fixture(true); await f.controller.refresh();
  f.controller.service.routingPauseReady = async () => true;
  f.controller.service.pause = async () => { throw new Error('Pause failed'); };
  await f.controller.changeState('pause');
  expect(f.controller.model.switchOn).toBe(true);
  expect(f.controller.model.canStart).toBe(true);
  expect(f.controller.model.busy).toBe(false);
  expect(f.alerts).toEqual(['Pause failed']);
});
