// Exercise the real manager and core in a disposable user launchd domain.
// It deliberately does not create the privileged production service or a TUN.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Paths, run } from '../src/system';
import { Service } from '../src/service';
import { install } from '../src/install';

if (process.platform !== 'darwin' || process.getuid?.() === 0) throw new Error('Run this smoke test as your logged-in macOS user.');
const base = await mkdtemp(join(tmpdir(), 'sbm-live-'));
const paths = new Paths(join(base, 'app'), join(base, 'boot'), `io.github.chendesheng.sbm.smoke-${process.pid}`, `gui/${process.getuid!()}`);
await paths.prepare();
const service = new Service(paths, run);
const target = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('sbm smoke ok') });
try {
  console.log(await install(service));
  // Reserve a free port briefly, then hand it to sing-box.
  const socket = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = socket.port; socket.stop(true);
  const source = join(base, 'input.json');
  const config = JSON.parse(await readFile(resolve('examples/config.json'), 'utf8'));
  config.inbounds[0].listen_port = port;
  await Bun.write(source, JSON.stringify(config));
  console.log(await service.start(source));
  const pid = (await service.state()).pid;
  if (!pid || !(await service.start()).includes('already running') || (await service.state()).pid !== pid) throw new Error('Repeated start changed the process.');
  const proxied = await run(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--max-time', '5', '--noproxy', '', '--socks5-hostname', `127.0.0.1:${port}`, `http://127.0.0.1:${target.port}`]);
  if (proxied.code !== 0 || proxied.stdout !== 'sbm smoke ok') throw new Error(`Loopback proxy failed: ${proxied.stderr}`);
  await service.enable(); await service.pause(); await service.pause();
  if ((await service.state()).loaded) throw new Error('Pause did not unload the job.');
  console.log(await service.start()); await service.disable();
  console.log(await install(service));
  console.log(`PASS: official core, real launchd, repeated start/pause, loopback SOCKS traffic, boot-file enable/disable, idempotent install. Logs: ${paths.stderr}`);
} finally {
  await service.pause(); target.stop(true); await rm(base, { recursive: true, force: true });
}
