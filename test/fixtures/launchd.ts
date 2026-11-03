// Exercise the real manager and core in a disposable user launchd domain.
// It deliberately does not create the privileged production service or a TUN.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Paths, run } from '../../src/system';
import { Service } from '../../src/service';
import { install } from '../../src/install';
import { backupConfig, restoreConfig } from '../../src/backup';
import { migrateStorage } from '../../src/storage';

const uid = process.getuid?.();
if (process.platform !== 'darwin' || uid === undefined || uid === 0) throw new Error('Run this smoke test as your logged-in macOS user.');
const base = await mkdtemp(join(tmpdir(), 'sbm-live-'));
const paths = new Paths(join(base, 'app'), join(base, 'boot'), `io.github.chendesheng.sbm.smoke-${process.pid}`, `gui/${uid}`);
await paths.prepare();
const service = new Service(paths, run);
const target = createServer((_request, response) => { response.end('sbm smoke ok'); });
await new Promise<void>(resolve => { target.listen(0, '127.0.0.1', resolve); });
const address = target.address();
if (!address || typeof address === 'string') throw new Error('No HTTP listen address.');
try {
  console.log(await install(service));
  // Reserve a free port briefly, then hand it to sing-box.
  const socket = createSocket();
  await new Promise<void>(resolve => { socket.listen(0, '127.0.0.1', resolve); });
  const socketAddress = socket.address();
  if (!socketAddress || typeof socketAddress === 'string') throw new Error('No proxy listen address.');
  const port = socketAddress.port;
  await new Promise<void>((resolve, reject) => { socket.close(error => { if (error) reject(error); else resolve(); }); });
  const source = join(base, 'input.json');
  const config = JSON.parse(await readFile(resolve('examples/config.json'), 'utf8'));
  config.inbounds[0].listen_port = port;
  const rulePath = join(paths.base, 'direct.json');
  await writeFile(rulePath, JSON.stringify({ version: 1, rules: [{ domain: ['example.com'] }] }));
  config.route.rule_set = [{ type: 'local', tag: 'smoke', format: 'source', path: rulePath }];
  await writeFile(source, JSON.stringify(config));
  console.log(await service.start(source));
  const pid = (await service.state()).pid;
  if (!pid || !(await service.start()).includes('already running') || (await service.state()).pid !== pid) throw new Error('Repeated start changed the process.');
  const proxied = await run(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--max-time', '5', '--noproxy', '', '--socks5-hostname', `127.0.0.1:${port}`, `http://127.0.0.1:${address.port}`]);
  if (proxied.code !== 0 || proxied.stdout !== 'sbm smoke ok') throw new Error(`Loopback proxy failed: ${proxied.stderr}`);
  const backup = join(base, 'backup.zip');
  console.log(await backupConfig(paths, backup));
  await writeFile(rulePath, JSON.stringify({ version: 1, rules: [] }));
  console.log(await restoreConfig(service, backup));
  if (!(await service.state()).pid || !JSON.parse(await readFile(rulePath, 'utf8')).rules.length) throw new Error('Running restore failed.');
  const restored = await run(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--max-time', '5', '--noproxy', '', '--socks5-hostname', `127.0.0.1:${port}`, `http://127.0.0.1:${address.port}`]);
  if (restored.code !== 0 || restored.stdout !== 'sbm smoke ok') throw new Error(`Restored proxy failed: ${restored.stderr}`);
  await service.pause();
  console.log(await restoreConfig(service, backup));
  if ((await service.state()).loaded) throw new Error('Paused restore unexpectedly started the job.');
  await service.start();
  await service.enable(); await service.pause(); await service.pause();
  if ((await service.state()).loaded) throw new Error('Pause did not unload the job.');
  console.log(await service.start()); await service.disable();
  console.log(await install(service));
  const installedVersion = await service.version();
  const userPaths = new Paths(join(base, 'user/Library/Application Support/sbm'), paths.bootDir, paths.label, paths.domain, paths.base);
  const userService = new Service(userPaths, run);
  await migrateStorage(userService, { uid, gid: process.getgid?.() ?? 0 });
  if (!(await userService.state()).pid || await userService.version() !== installedVersion) throw new Error('User-path migration did not restore the live service.');
  const migrated = await run(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--max-time', '5', '--noproxy', '', '--socks5-hostname', `127.0.0.1:${port}`, `http://127.0.0.1:${address.port}`]);
  if (migrated.code !== 0 || migrated.stdout !== 'sbm smoke ok') throw new Error(`Migrated proxy failed: ${migrated.stderr}`);
  console.log(`PASS: official core, real launchd, running/paused backup restore, repeated start/pause, loopback SOCKS traffic, boot-file enable/disable, idempotent install. Logs: ${paths.stderr}`);
  console.log('PASS: live user-path migration preserves actual SOCKS traffic.');
} finally {
  try { await service.pause(); }
  finally { target.close(); await rm(base, { recursive: true, force: true }); }
}
