import { expect, test } from 'bun:test';
import { VpsClient, VpsController, type ExitMode, type ExitStatus, type WpsStatus } from '../src/app/vps';

const off: ExitStatus = { mode: 'off', requested_mode: 'off', switch_in_progress: false };
const stopped: WpsStatus = { available: true, enabled: false, running: false, state: 'inactive' };
const response = (value: unknown, status = 200) => ({ code: 0, stderr: '', stdout: `${typeof value === 'string' ? value : JSON.stringify(value)}\n${status}` });

test('panel requests use fresh CSRF, matching origin, ordered exit selections, and system TLS', async () => {
  const requests: { path: string; body: any }[] = [];
  let token = 0;
  const client = new VpsClient(async args => {
    expect(args.slice(0, 2)).toEqual(['/usr/bin/curl', '--disable']);
    expect(args).not.toContain('--insecure'); expect(args).not.toContain('--location');
    const path = new URL(args.at(-1)!).pathname;
    if (path === '/') return response(`<body data-csrf="fresh-${++token}">`);
    expect(args).toContain('Origin: https://vps.internal');
    expect(args).toContain(`X-CSRF-Token: fresh-${token}`);
    const body = JSON.parse(args[args.indexOf('--data-raw') + 1]);
    requests.push({ path, body });
    return response(path === '/api/wps' ? { ...stopped, enabled: body.enabled, running: body.enabled } : { accepted: true }, path === '/api/wps' ? 200 : 202);
  });
  await client.select('japan'); await client.select('usa_la'); await client.setWps(true);
  expect(token).toBe(3);
  expect(requests.map(x => x.path)).toEqual(['/api/switch', '/api/switch', '/api/wps']);
  expect(requests[0].body).toMatchObject({ mode: 'japan', sequence: 1 });
  expect(requests[1].body).toMatchObject({ mode: 'usa_la', sequence: 2, client_id: requests[0].body.client_id });
  expect(requests[0].body.client_id).toMatch(/^[a-f0-9]{32}$/);
  expect(requests[2].body).toEqual({ enabled: true });
});

test('failed control requests are not replayed and redirects are rejected', async () => {
  let writes = 0;
  const client = new VpsClient(async args => {
    if (args.at(-1)!.endsWith('/')) return response('<body data-csrf="token">');
    writes++; return response({ error: 'invalid token' }, 403);
  });
  await expect(client.select('japan')).rejects.toThrow('unavailable');
  expect(writes).toBe(1);
  await expect(new VpsClient(async () => response('', 308)).status()).rejects.toThrow('unavailable');
  await expect(new VpsClient(async () => response({ mode: 'unknown' })).status()).rejects.toThrow('Invalid');
  await expect(new VpsClient(async () => response({ available: true })).wps()).rejects.toThrow('Invalid');
});

class FakePanel extends VpsClient {
  exit: ExitStatus = { ...off };
  tunnel: WpsStatus = { ...stopped };
  readsFail = false;
  writesFail = false;
  writes = 0;
  override async status() { if (this.readsFail) throw Error('offline'); return this.exit; }
  override async wps() { if (this.readsFail) throw Error('offline'); return this.tunnel; }
  override async select(mode: ExitMode) {
    this.writes++;
    if (this.writesFail) throw Error('disconnected after sending');
    this.exit = { ...this.exit, requested_mode: mode, switch_in_progress: true };
  }
  override async setWps(enabled: boolean): Promise<WpsStatus> {
    this.writes++;
    if (this.writesFail) throw Error('disconnected after sending');
    return this.tunnel = { available: true, enabled, running: enabled, state: enabled ? 'active' : 'inactive' };
  }
}

test('exit checkmark follows applied status, not request acceptance; rollback and offline states recover', async () => {
  const panel = new FakePanel(), alerts: string[] = [];
  const control = new VpsController(panel, () => {}, value => alerts.push(value));
  await control.refresh(); await control.select('japan');
  expect(control.model).toMatchObject({ mode: 'off', exitLabel: 'Switching to Japan…', exitAvailable: false });
  await control.select('usa_la'); expect(panel.writes).toBe(1);
  panel.exit = { mode: 'japan', requested_mode: 'japan', switch_in_progress: false };
  await control.refresh(); expect(control.model).toMatchObject({ mode: 'japan', exitAvailable: true });
  await control.select('usa_la');
  panel.exit = { ...panel.exit, switch_in_progress: false, last_attempt: { state: 'failed' } };
  await control.refresh(); expect(control.model.exitLabel).toBe('Switch failed · Japan');
  panel.readsFail = true; await control.refresh();
  expect(control.model).toMatchObject({ mode: '', exitLabel: 'Unavailable', exitAvailable: false, wpsAvailable: false });
  panel.readsFail = false; await control.refresh(); expect(control.model.exitAvailable).toBe(true);
  expect(alerts).toEqual([]);
});

test('WPS handles startup/runtime mismatches, unavailable service and uncertain writes', async () => {
  const panel = new FakePanel(), alerts: string[] = [];
  const control = new VpsController(panel, () => {}, value => alerts.push(value));
  await control.refresh(); await control.setWps(true);
  expect(control.model).toMatchObject({ wpsEnabled: true, wpsLabel: 'On', wpsAvailable: true });
  panel.tunnel = { ...stopped, enabled: true, state: 'failed' }; await control.refresh();
  expect(control.model.wpsLabel).toBe('Failed · startup on');
  panel.writesFail = true; await control.setWps(false); await control.setWps(false);
  expect(panel.writes).toBe(2); expect(alerts).toHaveLength(1);
  expect(control.model).toMatchObject({ wpsEnabled: true, wpsLabel: 'Check status', wpsAvailable: false });
  panel.tunnel = { ...stopped, available: false }; await control.refresh(); await control.setWps(true);
  expect(control.model.wpsLabel).toBe('Not installed'); expect(panel.writes).toBe(2);
});

test('a read started before a WPS change cannot overwrite its confirmed result', async () => {
  const panel = new FakePanel();
  const control = new VpsController(panel, () => {}, () => {});
  await control.refresh();
  let resolve!: (status: WpsStatus) => void;
  panel.wps = () => new Promise<WpsStatus>(done => { resolve = done; });
  const read = control.refresh();
  await control.setWps(true); resolve(stopped); await read;
  expect(control.model).toMatchObject({ wpsEnabled: true, wpsLabel: 'On' });
});

test('WPS changes locally at once, ignores stale reads, and serializes the latest choice', async () => {
  const panel = new FakePanel();
  const pending: { enabled: boolean; resolve: (status: WpsStatus) => void }[] = [];
  panel.setWps = enabled => new Promise<WpsStatus>(resolve => { pending.push({ enabled, resolve }); });
  const control = new VpsController(panel, () => {}, () => {});
  await control.refresh();
  let resolveRead!: (status: WpsStatus) => void;
  panel.wps = () => new Promise<WpsStatus>(resolve => { resolveRead = resolve; });
  const reading = control.refresh();
  const writing = control.setWps(true);
  expect(control.model).toMatchObject({ wpsEnabled: true, wpsAvailable: true, wpsRevision: 1 });
  resolveRead(stopped); await reading;
  expect(control.model.wpsEnabled).toBe(true);
  await control.setWps(false);
  expect(control.model).toMatchObject({ wpsEnabled: false, wpsAvailable: true, wpsRevision: 2 });
  expect(pending.map(request => request.enabled)).toEqual([true]);
  pending[0].resolve({ ...stopped, enabled: true, running: true, state: 'active' });
  await Promise.resolve();
  expect(control.model.wpsEnabled).toBe(false);
  expect(pending.map(request => request.enabled)).toEqual([true, false]);
  pending[1].resolve(stopped); await writing;
  expect(control.model).toMatchObject({ wpsEnabled: false, wpsAvailable: true, wpsLabel: 'Off' });
});

test('rapid WPS toggles coalesce when the first request already achieves the latest choice', async () => {
  const panel = new FakePanel();
  let resolve!: (status: WpsStatus) => void, writes = 0;
  panel.setWps = () => { writes++; return new Promise<WpsStatus>(done => { resolve = done; }); };
  const control = new VpsController(panel, () => {}, () => {});
  await control.refresh();
  const writing = control.setWps(true);
  await control.setWps(false); await control.setWps(true);
  resolve({ ...stopped, enabled: true, running: true, state: 'active' }); await writing;
  expect(writes).toBe(1);
  expect(control.model).toMatchObject({ wpsEnabled: true, wpsAvailable: true, wpsRevision: 3 });
});

test('a failed latest WPS write restores confirmed state; a click queued before pause is acknowledged', async () => {
  const panel = new FakePanel(), alerts: string[] = [];
  let reject!: (error: Error) => void;
  panel.setWps = () => new Promise<WpsStatus>((_resolve, fail) => { reject = fail; });
  const control = new VpsController(panel, () => {}, value => alerts.push(value));
  await control.refresh();
  const writing = control.setWps(true);
  expect(control.model.wpsEnabled).toBe(true);
  reject(Error('offline')); await writing;
  expect(control.model).toMatchObject({ wpsEnabled: false, wpsAvailable: false });
  expect(alerts).toHaveLength(1);
  await control.refresh(); await control.setWps(true, false);
  expect(control.model).toMatchObject({ wpsEnabled: false, wpsAvailable: true, wpsRevision: 2 });
});
