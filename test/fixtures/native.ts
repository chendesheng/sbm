// Compile this test with ScriptC so it exercises the actual native runtime.
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Paths, atomicWrite, writeNewFile, run, selfInvocation, withLock, type Runner } from '../../src/system';
import { Service } from '../../src/service';
import { backupConfig, restoreConfig } from '../../src/backup';
import { manageRoute, normalize, routeFile } from '../../src/routes';
import { parseArgs } from '../../src/args';
import { migrateStorage, readRegistration } from '../../src/storage';

function check(ok: boolean, message: string) { if (!ok) throw new Error(message); }
async function rejects(action: () => Promise<unknown>, message: string) {
  let failed = false;
  try { await action(); } catch { failed = true; }
  check(failed, message);
}
async function smoke() {
  const root = await mkdtemp(join(tmpdir(), 'sbm-native-'));
  const paths = new Paths(join(root, 'app & data'), join(root, 'boot'));
  let active = false, invalid = false;
  const runner: Runner = async args => {
    if (args[0] === '/bin/launchctl') {
      if (args[1] === 'print') return active ? { code: 0, stdout: 'state = running\npid = 101\n', stderr: '' } : { code: 1, stdout: '', stderr: 'Could not find service' };
      if (args[1] === 'bootstrap') active = true;
      if (args[1] === 'bootout') active = false;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[1] === 'check') return { code: invalid ? 1 : 0, stdout: '', stderr: invalid ? 'invalid config' : '' };
    throw new Error(`Unexpected fixture command: ${args[0]}`);
  };
  const service = new Service(paths, runner, { attempts: 4, interval: 1, stableSamples: 1 });
  try {
    const child = await run([...selfInvocation(), '--child']);
    check(child.code === 0 && child.stdout === 'native child\n', 'Native self invocation failed');
    const cli = resolve('dist/sbm');
    const version = await run([cli, '--version']);
    check(version.code === 0 && version.stdout === '0.1.1\n', 'CLI version failed');
    const bad = await run([cli, 'unknown']);
    check(bad.code !== 0 && bad.stderr.includes('Unknown command'), 'CLI error status failed');
    const status = await run([cli, 'status']);
    check(status.code === 0 && status.stdout.includes('State: ') && !status.stdout.includes('administrator privileges'), 'Status must not request sudo');
    const streams = await run(['/bin/sh', '-c', 'printf stdout; printf stderr >&2; exit 7']);
    check(streams.code === 7 && streams.stdout === 'stdout' && streams.stderr === 'stderr', 'Subprocess output/status failed');
    await rejects(() => run(['/no/such/sbm-command']), 'Missing executable must reject');
    const started = Date.now();
    const timeout = await run(['/bin/sleep', '5'], 50);
    check(timeout.code !== 0 && Date.now() - started < 4000, 'Subprocess timeout failed');
    console.log('PASS: subprocesses and native self invocation.');

    await paths.prepare();
    await writeFile(paths.stdout, 'retained log'); await paths.prepare();
    check(await readFile(paths.stdout, 'utf8') === 'retained log', 'Preparing paths truncated a log');
    await mkdir(paths.bootDir);
    await writeNewFile(paths.core, 'fixture');
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 42]);
    await atomicWrite(join(paths.base, 'asset.bin'), bytes);
    check((await readFile(join(paths.base, 'asset.bin'))).toString('hex') === '00ff800d0a2a', 'Binary atomic write failed');
    check(((await stat(paths.base)).mode & 0o777) === 0o700, 'Managed directory permissions changed');
    check(((await stat(join(paths.base, 'asset.bin'))).mode & 0o777) === 0o600, 'File permissions changed');
    await rejects(() => writeNewFile(join(paths.base, 'asset.bin'), 'overwrite'), 'Exclusive creation must reject existing files');
    const config = JSON.stringify({
      marker: 'saved',
      nested: [null, true, 42, 'text', [{ type: 'local', path: 'asset.bin' }]],
      tls: { certificate_path: ['asset.bin', null, 42] },
    });
    await atomicWrite(paths.config, JSON.stringify({ nested: [null, [{ type: 'local', path: 'missing.bin' }]] }));
    await rejects(() => backupConfig(paths, join(root, 'missing.zip')), 'Nested missing asset must reject');
    await atomicWrite(paths.config, config);
    await atomicWrite(routeFile(paths, false), '{"version":1,"rules":[]}');
    check(parseArgs(['start', '--config', 'config.json']).value === 'config.json', 'Argument narrowing failed');
    check(normalize('domain', '例子.测试') === 'xn--fsqu00a.xn--0zwm56d', 'IDN normalization failed');
    await manageRoute(paths, { action: 'add', priority: false, field: 'domain', value: 'Example.com', outbound: 'direct' });
    check((await manageRoute(paths, { action: 'list', priority: false })).includes('--domain example.com'), 'Route addition failed');
    await manageRoute(paths, { action: 'remove', priority: false, field: 'domain', value: 'example.com', outbound: 'direct' });
    check(await readFile(routeFile(paths, false), 'utf8') === '{\n  "version": 1,\n  "rules": []\n}\n', 'Empty route deletion failed');
    console.log('PASS: private binary files and routes.');
    let locks = 0;
    await Promise.all([withLock(paths, async () => { locks++; }), withLock(paths, async () => { locks++; })]);
    check(locks === 2, 'Lock contention failed');
    console.log('PASS: locks.');

    await service.start(); console.log('PASS: service start.');
    await service.enable();
    const backup = join(root, 'backup.zip');
    // Exercise descriptor-based ownership changes without needing root.
    process.env.SUDO_UID = String(process.getuid?.());
    process.env.SUDO_GID = String(process.getgid?.());
    await backupConfig(paths, backup);
    console.log('PASS: backup.');
    const info = await stat(backup);
    check((info.mode & 0o777) === 0o600 && info.uid === process.getuid?.(), 'Backup permissions/ownership failed');
    await rejects(() => backupConfig(paths, backup), 'Backup must not overwrite an existing file');
    console.log('PASS: backup permissions and exclusive output.');
    await atomicWrite(paths.config, '{"changed":true}');
    await atomicWrite(join(paths.base, 'asset.bin'), 'changed');
    await service.disable();
    await restoreConfig(service, backup);
    console.log('PASS: running restore.');
    check(active && await readFile(paths.config, 'utf8') === config, 'Running restore failed');
    check((await readFile(join(paths.base, 'asset.bin'))).toString('hex') === '00ff800d0a2a', 'Binary backup roundtrip failed');
    check((await readFile(paths.bootPlist, 'utf8')).includes('<plist'), 'Boot setting restore failed');
    await atomicWrite(paths.config, '{"current":true}'); invalid = true;
    await rejects(() => restoreConfig(service, backup), 'Invalid restore must reject');
    check(active && await readFile(paths.config, 'utf8') === '{"current":true}', 'Restore rollback failed');
    invalid = false;
    await service.stop(); await restoreConfig(service, backup);
    check(!active, 'Paused restore started the service');
    const legacy = new Paths(join(root, 'legacy'), join(root, 'migration-boot'));
    await legacy.prepare();
    await writeNewFile(legacy.core, 'fixture');
    await atomicWrite(join(legacy.base, 'direct.json'), '{"version":1,"rules":[]}');
    await atomicWrite(legacy.config, JSON.stringify({ route: { rule_set: [{ type: 'local', path: join(legacy.base, 'direct.json') }] } }));
    const userPaths = new Paths(join(root, 'user/Library/Application Support/sbm'), legacy.bootDir, legacy.label, legacy.domain, legacy.base);
    const userService = new Service(userPaths, runner, { attempts: 4, interval: 1, stableSamples: 1 });
    await migrateStorage(userService, { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 });
    check((await readRegistration(legacy.base))?.base === userPaths.base, 'Native owner registration failed');
    check((await readFile(userPaths.config, 'utf8')).includes(join(userPaths.base, 'direct.json')), 'Native config relocation failed');
    check((await readFile(userPaths.core, 'utf8')) === 'fixture', 'Native binary migration failed');
    await manageRoute(userPaths, { action: 'add', priority: false, field: 'domain', value: 'example.com', outbound: 'direct' });
    await backupConfig(userPaths, join(root, 'migrated.zip'));
    console.log('PASS: user-path migration, owner registration, unprivileged status, routes and backup.');
    console.log('PASS: native CLI/self invocation, subprocess output/errors/timeout, private binary files, routes, locks, backup ownership, running/paused restore and rollback.');
  } finally { await rm(root, { recursive: true, force: true }); }
}
if (process.argv[2] === '--child') console.log('native child');
else {
  try { await smoke(); }
  catch (error) { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
}
