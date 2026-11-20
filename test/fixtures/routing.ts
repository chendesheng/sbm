// Real core + isolated loopback listeners. Never touches the installed service/config.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { createSocket as createDatagram } from 'node:dgram';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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
// The authoritative server owns the names. Change its answer while paused to
// prove the client forwards queries rather than keeping a local host inventory.
let privateName = 'first.devices.test', privateQueries = 0;
const authoritative = createDatagram('udp4');
authoritative.on('message', (query, peer) => {
  let end = 12;
  const labels: string[] = [];
  while (query[end]) { const size = query[end++]; labels.push(query.subarray(end, end + size).toString()); end += size; }
  const type = query.readUInt16BE(end + 1);
  const known = labels.join('.') === privateName;
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(known ? 0x8580 : 0x8583, 2);
  header.writeUInt16BE(known && type === 1 ? 1 : 0, 6);
  header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
  const answer = known && type === 1 ? Buffer.from('c00c00010001000000000004c0000214', 'hex') : Buffer.alloc(0);
  privateQueries++;
  authoritative.send(Buffer.concat([header, query.subarray(12, end + 5), answer]), peer.port, peer.address);
});
await new Promise<void>(resolve => authoritative.bind(0, '127.0.0.1', resolve));
await paths.prepare();
await writeFile(paths.config, JSON.stringify({
  log: { level: 'error' },
  inbounds: [
    { type: 'mixed', tag: 'proxy', listen: '127.0.0.1', listen_port: proxyPort },
    { type: 'direct', tag: 'dns', listen: '127.0.0.1', listen_port: dnsPort, override_address: '127.0.0.1', override_port: 53 },
  ],
  outbounds: [{ type: 'direct', tag: 'normal' }],
  route: { default_domain_resolver: 'local', rules: [{ inbound: 'dns', action: 'hijack-dns' }, { action: 'reject' }] },
  dns: {
    servers: [{ type: 'local', tag: 'local' }, { type: 'hosts', tag: 'static', predefined: { 'sbm-route-check.invalid': ['192.0.2.10'] } }],
    rules: [{ server: 'static', preferred_by: 'static' }, { action: 'predefined', rcode: 'REFUSED' }],
  },
}));
await writeFile(paths.config, await prepareRoutingConfig(paths));
const config = JSON.parse(await readFile(paths.config, 'utf8'));
config.dns.servers.push({ type: 'udp', tag: 'private', server: '127.0.0.1', server_port: authoritative.address().port });
config.dns.rules.unshift({ domain_suffix: ['devices.test'], action: 'route', server: 'private', disable_cache: true });
await writeFile(paths.config, JSON.stringify(config));
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
async function dnsQuery(name = 'localhost', type = 1): Promise<Buffer> {
  const socket = createDatagram('udp4');
  const question = Buffer.from([0, 0, type, 0, 1]);
  const query = Buffer.concat([Buffer.from('123401000001000000000000', 'hex'),
    ...name.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), question]);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DNS timeout')), 3000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('message', bytes => { clearTimeout(timer); resolve(bytes); });
      socket.send(query, dnsPort, '127.0.0.1');
    });
  } finally { socket.close(); }
}
async function checkHostRecord() {
  const answer = await dnsQuery('sbm-route-check.invalid');
  if ((answer[3] & 15) !== 0 || answer.readUInt16BE(6) !== 1 || !answer.subarray(-4).equals(Buffer.from([192, 0, 2, 10])))
    throw new Error('Configured host record disappeared across the routing switch');
  const ipv6 = await dnsQuery('sbm-route-check.invalid', 28);
  if ((ipv6[3] & 15) !== 0 || ipv6.readUInt16BE(6) !== 0)
    throw new Error('An IPv4-only host must return empty AAAA, not NXDOMAIN');
}
async function checkPrivateRecord() {
  const before = privateQueries;
  const answer = await dnsQuery(privateName);
  if ((answer[3] & 15) !== 0 || !answer.subarray(-4).equals(Buffer.from([192, 0, 2, 20])) || privateQueries <= before)
    throw new Error('Private zone query did not reach its authoritative server');
}
try {
  let ready = false;
  for (let n = 0; n < 50; n++) {
    try { await routing.mode(); ready = true; break; } catch { await sleep(100); }
  }
  if (!ready) throw new Error(`Core did not start: ${log}`);
  const pid = child.pid;
  if ((await request('127.0.0.1')).code === 0) throw new Error('Normal routing should reject the request');
  if (((await dnsQuery('sbm-unlisted.invalid'))[3] & 15) !== 5) throw new Error('Normal DNS should refuse the query');
  await checkHostRecord();
  await checkPrivateRecord();
  await service.pause();
  await checkHostRecord();
  privateName = 'added-while-paused.devices.test';
  await checkPrivateRecord();
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
  await checkHostRecord();
  await checkPrivateRecord();
  if ((await request('127.0.0.1')).code === 0) throw new Error('Resume did not restore routing');
  if (((await dnsQuery('sbm-unlisted.invalid'))[3] & 15) !== 5) throw new Error('Resume did not restore DNS');
  if (child.pid !== pid || child.exitCode !== null) throw new Error('Pause/Start changed the core process');
  console.log('PASS: real sing-box routing and DNS switch direct and back; static A/AAAA survive; private DNS reaches its server including a name added while paused; same PID, no lifecycle commands or authorization.');
} finally {
  child.kill(); await exited; target.close(); authoritative.close(); await rm(base, { recursive: true, force: true });
}
