import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Paths, exists, type Runner } from '../src/system';
import { Service, plist } from '../src/service';
import { migrateStorage, readRegistration, registerStorage, relocateConfig } from '../src/storage';
import { statusText } from '../src/status';
import { backupConfig } from '../src/backup';
import { manageRoute } from '../src/routes';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(running = false) {
  const root = await mkdtemp(join(tmpdir(), 'sbm-storage-')); roots.push(root);
  const old = new Paths(join(root, 'system'), join(root, 'boot'));
  const paths = new Paths(join(root, 'user/Library/Application Support/sbm'), old.bootDir, old.label, old.domain, old.base);
  await old.prepare();
  await writeFile(old.core, 'core', { mode: 0o755 });
  await writeFile(join(old.base, 'direct.json'), '{"version":1,"rules":[]}');
  await writeFile(old.config, JSON.stringify({ route: { rule_set: [{ type: 'local', path: join(old.base, 'direct.json') }] } }));
  await writeFile(old.stdout, 'retained log');
  await writeFile(join(old.base, 'cache.db'), 'retained cache');
  await writeFile(old.plist, plist(old));
  let active = running, failures = 0;
  const calls: string[][] = [];
  const runner: Runner = async args => {
    calls.push(args);
    if (args[0] === '/bin/launchctl') {
      if (args[1] === 'print') return active ? { code: 0, stdout: 'state = running\npid = 123\n', stderr: '' } : { code: 1, stdout: '', stderr: 'Could not find service' };
      if (args[1] === 'bootout') active = false;
      if (args[1] === 'bootstrap') {
        if (failures) { failures--; return { code: 1, stdout: '', stderr: 'simulated launch failure' }; }
        active = true;
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[1] === 'version') return { code: 0, stdout: 'sing-box version 1.0.0\n', stderr: '' };
    if (args[1] === 'check') return { code: 0, stdout: '', stderr: '' };
    throw new Error(`Unexpected command: ${args[0]}`);
  };
  const service = new Service(paths, runner, { attempts: 4, interval: 1, stableSamples: 1 });
  const owner = { uid: process.getuid!(), gid: process.getgid!() };
  return { root, old, paths, service, owner, calls, get active() { return active; }, set failures(value: number) { failures = value; } };
}

test('migrates core, assets, logs and cache into user storage; paused stays paused', async () => {
  const f = await fixture();
  await migrateStorage(f.service, f.owner);
  expect(f.active).toBe(false);
  expect(await exists(f.old.core)).toBe(false);
  expect(await readFile(f.paths.core, 'utf8')).toBe('core');
  expect(await readFile(f.paths.stdout, 'utf8')).toBe('retained log');
  expect(await readFile(join(f.paths.base, 'cache.db'), 'utf8')).toBe('retained cache');
  expect(await readFile(f.paths.config, 'utf8')).toContain(join(f.paths.base, 'direct.json'));
  expect((await stat(f.paths.base)).mode & 0o777).toBe(0o700);
  expect((await stat(f.paths.systemBase)).mode & 0o777).toBe(0o755);
  expect(await readRegistration(f.paths.systemBase)).toEqual({ version: 1, ...f.owner, base: f.paths.base });
  // The operator can update and back up relocated config with no privileged runner.
  await manageRoute(f.paths, { action: 'add', priority: false, field: 'domain', value: 'example.com', outbound: 'direct' });
  await backupConfig(f.paths, join(f.root, 'backup.zip'));
  expect((await stat(join(f.root, 'backup.zip'))).uid).toBe(f.owner.uid);
  expect(await exists(join(f.old.base, '.lock'))).toBe(false);
  expect(await exists(join(f.paths.base, '.lock'))).toBe(false);
});

test('running migration updates runtime and boot definitions and is idempotent', async () => {
  const f = await fixture(true);
  await new Service(f.old, f.service.runner).enable();
  await migrateStorage(f.service, f.owner);
  expect(f.active).toBe(true);
  expect(await readFile(f.paths.plist, 'utf8')).toContain(f.paths.core);
  expect(await readFile(f.paths.bootPlist, 'utf8')).toContain(f.paths.core);
  const launches = f.calls.filter(args => args[1] === 'bootstrap').length;
  await migrateStorage(f.service, f.owner);
  expect(f.calls.filter(args => args[1] === 'bootstrap').length).toBe(launches);
});

test('failed migration restores original paths, config bytes, boot setting and running service', async () => {
  const f = await fixture(true);
  await new Service(f.old, f.service.runner).enable();
  const config = await readFile(f.old.config, 'utf8'), boot = await readFile(f.old.bootPlist, 'utf8');
  f.failures = 1;
  await expect(migrateStorage(f.service, f.owner)).rejects.toThrow('Previous storage and service state restored');
  expect(f.active).toBe(true);
  expect(await readFile(f.old.config, 'utf8')).toBe(config);
  expect(await readFile(f.old.bootPlist, 'utf8')).toBe(boot);
  expect(await exists(f.old.core)).toBe(true);
  expect(await readRegistration(f.paths.systemBase)).toBeUndefined();
});

test('migration refuses destination collisions before pausing or replacing files', async () => {
  const f = await fixture(true);
  await f.paths.prepare();
  await writeFile(f.paths.core, 'other installation');
  await expect(migrateStorage(f.service, f.owner)).rejects.toThrow('destination already exists');
  expect(f.active).toBe(true);
  expect(f.calls.some(args => args[1] === 'bootout')).toBe(false);
  expect(await readFile(f.paths.core, 'utf8')).toBe('other installation');
});

test('relocation preserves JSONC and does not rewrite unrelated path prefixes', () => {
  const input = '// comment\n{"path":"/old/sbm/rules.json","relative":"rules.json","other":"/old/sbm-other/x"}';
  expect(relocateConfig(input, '/old/sbm', '/new/sbm')).toBe('// comment\n{"path":"/new/sbm/rules.json","relative":"rules.json","other":"/old/sbm-other/x"}');
});

test('registration cannot silently switch an existing system service to another owner or directory', async () => {
  const f = await fixture();
  await f.paths.prepare();
  await registerStorage(f.paths, f.owner);
  await expect(registerStorage(f.paths, { uid: f.owner.uid + 1, gid: f.owner.gid })).rejects.toThrow('different user');
});

test('status reads launchd directly without privileged commands and preserves real errors', async () => {
  const f = await fixture(true);
  const text = await statusText(new Service(f.old, f.service.runner));
  expect(text).toContain('State: running (PID 123)');
  expect(text).toContain('Core: 1.0.0');
  expect(f.calls.some(args => args[0].includes('sudo'))).toBe(false);
  const denied = new Service(f.old, async () => ({ code: 1, stdout: '', stderr: 'Operation not permitted' }));
  await expect(statusText(denied)).rejects.toThrow('Cannot read launchd state');
});
