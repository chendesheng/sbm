// Real core + isolated loopback listeners. Never touches the installed service/config.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { createSocket as createDatagram } from 'node:dgram';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Paths, run } from '../../src/system';
import { Service } from '../../src/service';
import { RoutingMode, prepareRoutingConfig } from '../../src/routing-mode';

async function port() {
  const socket = createSocket();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  await new Promise<void>(resolve => socket.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('No port');
  return address.port;
}
const base = await mkdtemp(join(tmpdir(), 'sbm-routing-live-'));
const paths = new Paths(base);
const core = process.env.SBM_TEST_CORE || join(homedir(), 'Library/Application Support/sbm/bin/sing-box');
const target = createServer((_request, response) => response.end('direct routing works'));
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const address = target.address();
if (!address || typeof address === 'string') throw new Error('No HTTP address');
const proxyPort = await port(), dnsPort = await port();
await paths.prepare();
await writeFile(paths.config, JSON.stringify({
  log: { level: 'error' },
  inbounds: [
    { type: 'mixed', tag: 'proxy', listen: '127.0.0.1', listen_port: proxyPort },
    { type: 'direct', tag: 'dns', listen: '127.0.0.1', listen_port: dnsPort, override_address: '127.0.0.1', override_port: 53 },
  ],
  outbounds: [{ type: 'direct', tag: 'normal' }],
  route: { default_domain_resolver: 'local', rules: [{ inbound: 'dns', action: 'hijack-dns' }, { action: 'reject' }] },
  dns: { servers: [{ type: 'local', tag: 'local' }], rules: [{ action: 'predefined', rcode: 'REFUSED' }] },
}));
await writeFile(paths.config, await prepareRoutingConfig(paths));
const check = await run([core, 'check', '-D', base, '-c', paths.config]);
if (check.code) throw new Error(check.stderr);
const child = spawn(core, ['run', '-D', base, '-c', paths.config], { stdio: ['ignore', 'ignore', 'pipe'] });
let log = ''; child.stderr.on('data', data => { log += data.toString(); });
const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
const routing = new RoutingMode(paths);
const service = new Service(paths, async args => {
  if (args[0] === '/bin/launchctl' && args[1] === 'print') return { code: 0, stdout: `state = running\npid = ${child.pid}\n`, stderr: '' };
  if (args[1] === 'check') return run([core, ...args.slice(1)]);
  throw new Error(`Unexpected lifecycle command: ${args[0]} ${args[1]}`);
});
async function request(host: string) {
  return run(['/usr/bin/curl', '--silent', '--show-error', '--max-time', '3', '--noproxy', '', '--socks5-hostname', `127.0.0.1:${proxyPort}`, `http://${host}:${address && typeof address !== 'string' ? address.port : 0}`]);
}
async function dnsQuery(): Promise<Buffer> {
  const socket = createDatagram('udp4');
  // Standard A query for localhost.
  const query = Buffer.from('123401000001000000000000096c6f63616c686f73740000010001', 'hex');
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DNS timeout')), 3000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('message', bytes => { clearTimeout(timer); resolve(bytes); });
      socket.send(query, dnsPort, '127.0.0.1');
    });
  } finally { socket.close(); }
}
try {
  let ready = false;
  for (let n = 0; n < 50; n++) {
    try { await routing.mode(); ready = true; break; } catch { await sleep(100); }
  }
  if (!ready) throw new Error(`Core did not start: ${log}`);
  const pid = child.pid;
  if ((await request('127.0.0.1')).code === 0) throw new Error('Normal routing should reject the request');
  if (((await dnsQuery())[3] & 15) !== 5) throw new Error('Normal DNS should refuse the query');
  await service.pause();
  if (!await service.routingPaused()) throw new Error('Pause was not reflected in status');
  for (const host of ['127.0.0.1', 'localhost']) {
    const result = await request(host);
    if (result.code || result.stdout !== 'direct routing works') throw new Error(`Paused direct request failed: ${result.stderr} ${log}`);
  }
  const dns = await dnsQuery();
  if ((dns[3] & 15) !== 0 || dns.readUInt16BE(6) === 0) throw new Error('Paused DNS did not resolve localhost');
  // requireCore checks the managed path; this fixture uses the existing binary.
  await writeFile(paths.core, 'fixture presence marker');
  await service.start();
  if ((await request('127.0.0.1')).code === 0) throw new Error('Resume did not restore routing');
  if (((await dnsQuery())[3] & 15) !== 5) throw new Error('Resume did not restore DNS');
  if (child.pid !== pid || child.exitCode !== null) throw new Error('Pause/Start changed the core process');
  console.log('PASS: real sing-box TCP and UDP DNS switch direct and back; same PID, no lifecycle commands or authorization.');
} finally {
  child.kill(); await exited; target.close(); await rm(base, { recursive: true, force: true });
}
