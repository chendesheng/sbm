import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { managedStorage } from '../../src/storage';
import { VpsClient, VpsController, vpsOrigin, type ExitMode } from '../../src/app/vps';

// Optional read-only check against the configured private panel.
if (process.argv.includes('--live')) {
  const storage = await managedStorage();
  const client = new VpsClient(fetch, await vpsOrigin(storage.paths));
  const [exit, wps] = await Promise.all([client.status(), client.wps()]);
  console.log(`PASS: live VPS status: ${exit.mode}; WPS enabled=${wps.enabled}, running=${wps.running}`);
} else {
  let mode: ExitMode = 'off', requested: ExitMode = 'off', pending = false, wps = false, token = 0, writes = 0;
  const server = createServer(async (request, response) => {
    if (request.url === '/redirect') { response.writeHead(307, { Location: '/api/wps' }); response.end(); return; }
    if (request.url === '/wait') return;
    if (request.url === '/') { response.end(`<body data-csrf="token-${++token}">`); return; }
    response.setHeader('Content-Type', 'application/json');
    const status = () => ({ mode, requested_mode: requested, switch_in_progress: pending });
    const tunnel = () => ({ available: true, enabled: wps, running: wps, state: wps ? 'active' : 'inactive' });
    if (request.method === 'GET') {
      response.end(JSON.stringify(request.url === '/api/status' ? status() : tunnel())); return;
    }
    assert.equal(request.headers.origin, `http://${request.headers.host}`);
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
    const client = new VpsClient(fetch, `http://127.0.0.1:${address.port}`);
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
    const redirected = fetch(`http://127.0.0.1:${address.port}/redirect`, {
      method: 'POST', headers: { 'X-CSRF-Token': 'must-not-forward' }, body: '{}', redirect: 'error',
    });
    await assert.rejects(redirected); assert.equal(writes, 7);
    const abort = new AbortController();
    const waiting = fetch(`http://127.0.0.1:${address.port}/wait`, { signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    await assert.rejects(waiting);

    console.log('PASS: native VPS transport via HTTP fetch without subprocesses, CSRF, applied exits and WPS switch with loopback panel fixture.');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
