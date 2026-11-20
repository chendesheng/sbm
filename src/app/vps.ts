import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import type { Paths } from '../system';

export type VpsRequest = (url: string, options: RequestInit) => Promise<Response>;

export const exitModes = ['off', 'japan', 'usa_la'] as const;
export type ExitMode = typeof exitModes[number];
export const exitNames: Record<ExitMode, string> = { off: 'DMIT direct', japan: 'Japan', usa_la: 'Los Angeles' };
export type ExitStatus = { mode: ExitMode; switch_in_progress: boolean; requested_mode: ExitMode; last_attempt?: { state?: string } };
export type WpsStatus = { available: boolean; enabled: boolean; running: boolean; state: string };
export type VpsModel = {
  mode: ExitMode | ''; exitLabel: string; exitAvailable: boolean;
  wpsEnabled: boolean; wpsLabel: string; wpsAvailable: boolean; wpsRevision: number;
};

// The panel's existing numeric HTTP endpoint is forwarded through Xray to its
// loopback listener. Use the managed hosts mapping to avoid system DNS failures.
export async function vpsOrigin(paths: Paths): Promise<string> {
  let config: { dns?: { servers?: { type?: string; predefined?: Record<string, unknown> }[] } };
  try { config = JSON.parse(await readFile(paths.config, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) return 'http://vps.internal'; throw error; }
  for (const server of config.dns?.servers || []) {
    if (server.type !== 'hosts') continue;
    const addresses = server.predefined?.['vps.internal'];
    const ip = Array.isArray(addresses) ? addresses.find((value: unknown) => typeof value === 'string' && isIP(value) === 4) : undefined;
    if (ip) return `http://${ip}:8787`;
  }
  return 'http://vps.internal';
}

// Use the same fetch API as release downloads; never redirect or replay writes.
export class VpsClient {
  private readonly clientId = randomBytes(16).toString('hex');
  private sequence = 0;
  constructor(private readonly requester: VpsRequest = fetch, private readonly origin = 'http://vps.internal') {}

  private async request(path: string, body?: object, token = ''): Promise<string> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), body ? 45_000 : 15_000);
    try {
      const response = await this.requester(`${this.origin}${path}`, {
        method: body ? 'POST' : 'GET',
        redirect: 'error', signal: controller.signal,
        headers: {
          'User-Agent': 'sbm/0.1.1',
          ...(body ? { 'Content-Type': 'application/json', Origin: this.origin, 'X-CSRF-Token': token } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch {
      throw new Error('VPS connection unavailable. Check the private connection, then reopen the menu.');
    } finally { clearTimeout(deadline); }
  }

  private async post(path: string, body: object): Promise<unknown> {
    // Fetch a fresh token for each user action; a panel restart invalidates it.
    const page = await this.request('/');
    const token = page.match(/\bdata-csrf=["']([A-Za-z0-9_-]+)["']/)?.[1];
    if (!token) throw new Error('The VPS panel did not provide a control token. Reopen the menu to refresh.');
    return JSON.parse(await this.request(path, body, token));
  }

  async status(): Promise<ExitStatus> {
    const value = JSON.parse(await this.request('/api/status'));
    if (!value || !exitModes.includes(value.mode) || !exitModes.includes(value.requested_mode) || typeof value.switch_in_progress !== 'boolean')
      throw new Error('Invalid VPS exit status.');
    return value;
  }
  async wps(): Promise<WpsStatus> { return this.parseWps(JSON.parse(await this.request('/api/wps'))); }
  private parseWps(value: any): WpsStatus {
    if (!value || typeof value.available !== 'boolean' || typeof value.enabled !== 'boolean' || typeof value.running !== 'boolean' || typeof value.state !== 'string')
      throw new Error('Invalid WPS status.');
    return value;
  }
  async select(mode: ExitMode): Promise<void> {
    const value = await this.post('/api/switch', { mode, client_id: this.clientId, sequence: ++this.sequence }) as { accepted?: boolean };
    if (!value?.accepted) throw new Error('The exit request was not accepted. Reopen the menu to refresh.');
  }
  async setWps(enabled: boolean): Promise<WpsStatus> { return this.parseWps(await this.post('/api/wps', { enabled })); }
}

export class VpsController {
  readonly model: VpsModel = { mode: '', exitLabel: 'Checking…', exitAvailable: false, wpsEnabled: false, wpsLabel: 'Checking…', wpsAvailable: false, wpsRevision: 0 };
  private exitGeneration = 0;
  private wpsGeneration = 0;
  private exitReading = false;
  private wpsReading = false;
  private exitWriting = false;
  private wpsWriting = false;
  private wpsConfirmed = false;
  constructor(private readonly client: VpsClient, private readonly render: (model: VpsModel) => void, private readonly alert: (message: string) => void) {}

  async refresh(): Promise<void> { await Promise.all([this.refreshExit(), this.refreshWps()]); }
  private async refreshExit(): Promise<void> {
    if (this.exitReading || this.exitWriting) return;
    this.exitReading = true;
    const generation = this.exitGeneration;
    try {
      const status = await this.client.status();
      if (generation !== this.exitGeneration) return;
      this.model.mode = status.mode;
      this.model.exitAvailable = !status.switch_in_progress;
      this.model.exitLabel = status.switch_in_progress ? `Switching to ${exitNames[status.requested_mode]}…`
        : `${status.last_attempt?.state === 'failed' ? 'Switch failed · ' : ''}${exitNames[status.mode]}`;
    } catch {
      if (generation !== this.exitGeneration) return;
      this.model.mode = ''; this.model.exitAvailable = false; this.model.exitLabel = 'Unavailable';
    } finally { this.exitReading = false; this.render(this.model); }
  }
  private showWps(status: WpsStatus) {
    this.wpsConfirmed = status.enabled;
    this.model.wpsEnabled = status.enabled;
    this.model.wpsAvailable = status.available;
    this.model.wpsLabel = !status.available ? 'Not installed' : status.running ? 'On'
      : status.state === 'failed' ? 'Failed' : status.state === 'activating' ? 'Starting…' : 'Off';
    if (status.available && status.enabled !== status.running) this.model.wpsLabel += status.enabled ? ' · startup on' : ' · startup off';
  }
  private async refreshWps(): Promise<void> {
    if (this.wpsReading || this.wpsWriting) return;
    this.wpsReading = true;
    const generation = this.wpsGeneration;
    try {
      const status = await this.client.wps();
      if (generation === this.wpsGeneration) this.showWps(status);
    } catch {
      if (generation !== this.wpsGeneration) return;
      this.model.wpsAvailable = false; this.model.wpsLabel = 'Unavailable';
    } finally { this.wpsReading = false; this.render(this.model); }
  }
  async select(mode: ExitMode): Promise<void> {
    if (this.exitWriting || !this.model.exitAvailable || mode === this.model.mode) return;
    this.exitWriting = true; ++this.exitGeneration;
    this.model.exitAvailable = false; this.model.exitLabel = `Switching to ${exitNames[mode]}…`; this.render(this.model);
    try { await this.client.select(mode); }
    catch { this.model.exitLabel = 'Check status'; this.alert('The exit change could not be confirmed. It may still be running; reopen the menu to refresh.'); }
    finally { this.exitWriting = false; this.render(this.model); }
    // Acceptance is not completion. Only status updates the selected checkmark.
    await this.refreshExit();
  }
  async setWps(enabled: boolean, canChange = true): Promise<void> {
    // Acknowledge every native click, including one queued just before pause.
    ++this.model.wpsRevision;
    if (!canChange || !this.model.wpsAvailable) { this.render(this.model); return; }
    ++this.wpsGeneration;
    this.model.wpsEnabled = enabled;
    this.model.wpsLabel = enabled ? 'Starting…' : 'Stopping…'; this.render(this.model);
    if (this.wpsWriting) return;
    this.wpsWriting = true;
    try {
      for (;;) {
        const generation = this.wpsGeneration;
        const desired = this.model.wpsEnabled;
        try {
          const status = await this.client.setWps(desired);
          this.wpsConfirmed = status.enabled;
          // Keep the latest local selection while an older request completes.
          // If it already achieved that selection, no second write is needed.
          if (generation === this.wpsGeneration || (status.available
            && status.enabled === this.model.wpsEnabled && status.running === this.model.wpsEnabled)) {
            this.showWps(status); break;
          }
        } catch {
          if (generation !== this.wpsGeneration) continue;
          this.model.wpsEnabled = this.wpsConfirmed;
          this.model.wpsAvailable = false; this.model.wpsLabel = 'Check status';
          this.alert('The WPS change could not be confirmed. Reopen the menu to refresh before trying again.');
          break;
        }
      }
    } finally { this.wpsWriting = false; this.render(this.model); }
  }
}
