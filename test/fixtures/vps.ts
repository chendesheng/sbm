import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { VpsClient, VpsController, type ExitMode } from '../../src/app/vps';
import { run } from '../../src/system';

// Optional read-only check against the configured private panel.
if (process.argv.includes('--live')) {
  const client = new VpsClient();
  const [exit, wps] = await Promise.all([client.status(), client.wps()]);
  console.log(`PASS: live VPS status: ${exit.mode}; WPS enabled=${wps.enabled}, running=${wps.running}`);
} else {
  let mode: ExitMode = 'off', requested: ExitMode = 'off', pending = false, wps = false, token = 0, writes = 0;
  const server = createServer(async (request, response) => {
    if (request.url === '/') { response.end(`<body data-csrf="token-${++token}">`); return; }
    response.setHeader('Content-Type', 'application/json');
    const status = () => ({ mode, requested_mode: requested, switch_in_progress: pending });
    const tunnel = () => ({ available: true, enabled: wps, running: wps, state: wps ? 'active' : 'inactive' });
    if (request.method === 'GET') {
      response.end(JSON.stringify(request.url === '/api/status' ? status() : tunnel())); return;
    }
    assert.equal(request.headers.origin, 'https://vps.internal');
    assert.equal(request.headers['x-csrf-token'], `token-${token}`);
    let body = '';
    await new Promise<void>((resolve, reject) => {
      request.on('data', chunk => { body += chunk.toString(); });
      request.on('end', resolve); request.on('error', reject);
    });
    const payload = JSON.parse(body); writes++;
    if (request.url === '/api/switch') {
      assert.match(payload.client_id, /^[a-f0-9]{32}$/);
      requested = payload.mode; pending = true;
      response.writeHead(202); response.end(JSON.stringify({ accepted: true }));
    } else { wps = payload.enabled; response.end(JSON.stringify(tunnel())); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const client = new VpsClient(args => run(args.map(value => value === '=https' ? '=http'
      : value.replace('https://vps.internal/', `http://127.0.0.1:${address.port}/`)), 50_000));
    const control = new VpsController(client, () => {}, message => { throw Error(message); });
    await control.refresh(); assert.equal(control.model.mode, 'off');
    for (const next of ['japan', 'usa_la', 'off'] as ExitMode[]) {
      await control.select(next);
      assert.equal(control.model.exitAvailable, false); assert.notEqual(control.model.mode, next);
      mode = requested; pending = false;
      await control.refresh(); assert.equal(control.model.mode, next);
    }
    await control.setWps(true); assert.equal(control.model.wpsEnabled, true);
    await control.setWps(false); assert.equal(control.model.wpsEnabled, false);
    const changing = control.setWps(true);
    assert.equal(control.model.wpsEnabled, true); assert.equal(control.model.wpsAvailable, true);
    await control.setWps(false);
    assert.equal(control.model.wpsEnabled, false); assert.equal(control.model.wpsAvailable, true);
    await changing;
    assert.equal(control.model.wpsEnabled, false);
    assert.equal(writes, 7);
    console.log('PASS: native VPS transport, CSRF, applied exits and WPS switch with loopback panel fixture.');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
