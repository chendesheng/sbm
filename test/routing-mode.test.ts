import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Paths } from '../src/system';
import { PAUSED_MODE, RoutingMode, prepareRoutingConfig, routingPauseReady } from '../src/routing-mode';
import { Service } from '../src/service';
import { AppController } from '../src/app/controller';

const folders: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'sbm-routing-')); folders.push(base);
  const paths = new Paths(base, join(base, 'boot')); await paths.prepare();
  let mode = 'Global', closes = 0, failPatch = false, ignorePatch = false, failClose = false;
  const requests: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(request.headers.get('Authorization')).toBe('Bearer test-secret');
    requests.push(request.method + ' ' + new URL(request.url).pathname);
    if (request.method === 'PATCH') {
      if (failPatch) return new Response('', { status: 503 });
      const body = await request.json() as { mode: string };
      if (!ignorePatch) mode = body.mode;
    }
    if (request.method === 'DELETE') {
      if (failClose) return new Response('', { status: 503 });
      closes++;
    }
    return Response.json({ mode });
  } }); servers.push(server);
  const original = {
    experimental: { clash_api: { external_controller: `127.0.0.1:${server.port}`, secret: 'test-secret' } },
    route: { rules: [{ action: 'reject' }] },
    dns: { servers: [{ type: 'udp', tag: 'original', server: '127.0.0.1' }], rules: [{ action: 'reject' }] },
    outbounds: [{ type: 'direct', tag: 'direct' }],
  };
  await writeFile(paths.config, JSON.stringify(original));
  const prepared = await prepareRoutingConfig(paths);
  await writeFile(paths.config, prepared);
  return { paths, original, prepared, requests, routing: new RoutingMode(paths), get mode() { return mode; }, get closes() { return closes; },
    set failPatch(value: boolean) { failPatch = value; }, set ignorePatch(value: boolean) { ignorePatch = value; }, set failClose(value: boolean) { failClose = value; } };
}
test('setup puts direct traffic and DNS ahead of existing rules and preserves normal defaults', async () => {
  const f = await fixture(); const config = JSON.parse(f.prepared);
  expect(config.route.rules.slice(2)).toEqual(f.original.route.rules);
  expect(config.dns.rules.slice(1)).toEqual(f.original.dns.rules);
  expect(config.dns.servers[0]).toEqual(f.original.dns.servers[0]);
  expect(config.route.rules[0]).toEqual({ clash_mode: PAUSED_MODE, port: 53, action: 'hijack-dns' });
  expect(config.outbounds[1].domain_resolver).toBe(config.dns.rules[0].server);
  expect(await routingPauseReady(f.paths)).toBe(true);
  expect(await prepareRoutingConfig(f.paths)).toBe(f.prepared);
});
test('Pause closes old connections and Start restores the previous mode, including after repeated Pause', async () => {
  const f = await fixture(); await f.routing.change(true); await f.routing.change(true);
  expect(f.mode).toBe(PAUSED_MODE); expect(await f.routing.paused()).toBe(true);
  expect(f.closes).toBe(2);
  await f.routing.change(false);
  expect(f.mode).toBe('Global'); expect(f.closes).toBe(3);
  expect(await f.routing.paused()).toBe(false);
  await f.routing.change(false); expect(f.closes).toBe(3);
});
test('failed or ignored mode changes are reported without closing connections', async () => {
  const f = await fixture(); f.failPatch = true;
  await expect(f.routing.change(true)).rejects.toThrow('HTTP 503');
  expect(f.mode).toBe('Global'); expect(f.closes).toBe(0);
  f.failPatch = false; f.ignorePatch = true;
  await expect(f.routing.change(true)).rejects.toThrow('did not apply'); expect(f.closes).toBe(0);
});
test('connection cleanup failures report the changed state and can be retried', async () => {
  const f = await fixture(); f.failClose = true;
  await expect(f.routing.change(true)).rejects.toThrow('Routing mode changed');
  expect(await f.routing.paused()).toBe(true);
  f.failClose = false; await f.routing.change(true); await f.routing.change(false);
  expect(f.mode).toBe('Global');
});
test('refuses remote controllers before sending credentials', async () => {
  const f = await fixture(); const config = JSON.parse(f.prepared);
  config.experimental.clash_api.external_controller = '192.0.2.1:9090';
  await writeFile(f.paths.config, JSON.stringify(config));
  await expect(f.routing.mode()).rejects.toThrow('loopback'); expect(f.requests).toEqual([]);
});
test('menu Pause/Start uses the API without authorization or launchctl mutations and displays paused with a live PID', async () => {
  const f = await fixture(); await writeFile(f.paths.core, 'core');
  const calls: string[][] = [], alerts: string[] = [], authorized: string[] = [];
  const service = new Service(f.paths, async args => {
    calls.push(args);
    return { code: 0, stderr: '', stdout: args[1] === 'version' ? 'sing-box version 1.14.4' : 'state = running\npid = 101\n' };
  });
  const app = new AppController(service, { uid: process.getuid!(), gid: process.getgid!() }, async action => { authorized.push(action); return 0; }, () => {}, message => alerts.push(message));
  await app.refresh(); expect(app.model.status).toBe('running');
  await app.changeState('pause'); expect(app.model.status).toBe('paused'); expect(app.model.loaded).toBe(true);
  await app.changeState('start'); expect(app.model.status).toBe('running'); expect(f.mode).toBe('Global');
  expect(authorized).toEqual([]); expect(alerts).toEqual([]);
  expect(calls.filter(x => x[0] === '/bin/launchctl').every(x => x[1] === 'print')).toBe(true);
});

test('a failed Resume cleanup can be retried after the mode already changed', async () => {
  const f = await fixture(); await f.routing.change(true); f.failClose = true;
  await expect(f.routing.change(false)).rejects.toThrow('Routing mode changed');
  expect(f.mode).toBe('Global'); expect(await f.routing.pendingResume()).toBe(true);
  f.failClose = false; await f.routing.change(false);
  expect(await f.routing.pendingResume()).toBe(false);
});
test('lifecycle reapplication preserves the original resume mode after a core restart', async () => {
  const f = await fixture(); await f.routing.change(true);
  const config = JSON.parse(f.prepared);
  await fetch(`http://${config.experimental.clash_api.external_controller}/configs`, {
    method: 'PATCH', headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'rule' }),
  });
  await f.routing.change(true, true); await f.routing.change(false);
  expect(f.mode).toBe('Global');
});
test('setup recognizes reordered JSON keys but rejects a changed resolver', async () => {
  const f = await fixture(); const config = JSON.parse(f.prepared);
  config.route.rules[0] = { action: 'hijack-dns', port: 53, clash_mode: PAUSED_MODE };
  await writeFile(f.paths.config, JSON.stringify(config)); expect(await routingPauseReady(f.paths)).toBe(true);
  config.dns.servers[1].detour = 'proxy';
  await writeFile(f.paths.config, JSON.stringify(config)); expect(await routingPauseReady(f.paths)).toBe(false);
  await expect(prepareRoutingConfig(f.paths)).rejects.toThrow('reserved');
});

test('existing direct route-set tags do not collide with the pause mode name', async () => {
  const f = await fixture();
  await writeFile(f.paths.config, JSON.stringify({ ...f.original, route: { rules: [{ rule_set: 'sbm-direct-priority', outbound: 'direct' }] } }));
  const config = JSON.parse(await prepareRoutingConfig(f.paths));
  expect(config.route.rules[2].rule_set).toBe('sbm-direct-priority');
});

test('preserves every configured hosts resolver during Pause without changing normal DNS policy', async () => {
  const f = await fixture();
  const config = JSON.parse(f.prepared);
  const hosts = [
    { type: 'hosts', tag: 'static', predefined: { 'panel.internal': ['192.0.2.10'] } },
    { type: 'hosts', tag: 'files', path: ['/etc/hosts'] },
  ];
  config.dns.servers.push(...hosts);
  await writeFile(f.paths.config, JSON.stringify(config));
  expect(await routingPauseReady(f.paths)).toBe(false);
  const upgraded = JSON.parse(await prepareRoutingConfig(f.paths));
  expect(upgraded.dns.rules.slice(0, 2)).toEqual(hosts.map(server => ({
    clash_mode: PAUSED_MODE, preferred_by: server.tag, action: 'route', server: server.tag,
  })));
  expect(upgraded.dns.rules.slice(2)).toEqual(config.dns.rules);
  expect(upgraded.dns.servers).toEqual(config.dns.servers);
  expect(upgraded.route).toEqual(config.route);
  expect(upgraded.experimental).toEqual(config.experimental);
  await writeFile(f.paths.config, JSON.stringify(upgraded, null, 2) + '\n');
  expect(await routingPauseReady(f.paths)).toBe(true);
  expect(JSON.parse(await prepareRoutingConfig(f.paths))).toEqual(upgraded);
});

test('old configurations remain readable and resumable before the DNS setup upgrade', async () => {
  const f = await fixture();
  const config = JSON.parse(f.prepared);
  config.dns.servers.push({ type: 'hosts', tag: 'static', predefined: { 'panel.internal': ['192.0.2.10'] } });
  await writeFile(f.paths.config, JSON.stringify(config));
  await writeFile(f.paths.core, 'core');
  await f.routing.change(true);
  expect(await f.routing.paused()).toBe(true);
  expect(await routingPauseReady(f.paths)).toBe(false);
  const service = new Service(f.paths, async args => {
    expect(args).toEqual(['/bin/launchctl', 'print', f.paths.target]);
    return { code: 0, stderr: '', stdout: 'state = running\npid = 101\n' };
  });
  expect(await service.start()).toContain('resumed');
  expect(f.mode).toBe('Global');
  expect(await f.routing.pendingResume()).toBe(false);
});

test('explicit DNS policies before the Pause block survive setup and mode switches', async () => {
  const f = await fixture();
  const config = JSON.parse(f.prepared);
  const policy = { domain_suffix: ['devices.test'], action: 'route', server: 'original' };
  config.dns.rules.unshift(policy);
  await writeFile(f.paths.config, JSON.stringify(config));
  expect(await routingPauseReady(f.paths)).toBe(true);
  expect(JSON.parse(await prepareRoutingConfig(f.paths))).toEqual(config);
  await f.routing.change(true); await f.routing.change(false);
  expect(f.mode).toBe('Global');
  expect(JSON.parse(await readFile(f.paths.config, 'utf8'))).toEqual(config);

  config.dns.servers.push({ type: 'hosts', tag: 'static', predefined: { 'panel.test': ['192.0.2.10'] } });
  await writeFile(f.paths.config, JSON.stringify(config));
  const upgraded = JSON.parse(await prepareRoutingConfig(f.paths));
  expect(upgraded.dns.rules[0]).toEqual(policy);
  expect(upgraded.dns.rules[1].preferred_by).toBe('static');
  expect(upgraded.dns.rules.slice(2)).toEqual(config.dns.rules.slice(1));
});

test('a DNS exception cannot hide a damaged managed Pause block', async () => {
  const f = await fixture();
  const config = JSON.parse(f.prepared);
  config.dns.rules.unshift({ domain_suffix: ['devices.test'], server: 'original' });
  config.dns.rules[1].server = 'original';
  await writeFile(f.paths.config, JSON.stringify(config));
  expect(await routingPauseReady(f.paths)).toBe(false);
  await expect(prepareRoutingConfig(f.paths)).rejects.toThrow('reserved');
});
