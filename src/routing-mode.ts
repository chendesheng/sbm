import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { atomicWrite, optionalRead, type Paths } from './system';

export const PAUSED_MODE = 'sbm-direct';
const DIRECT = 'sbm-pause-direct';
const DNS = 'sbm-pause-dns';
type Config = Record<string, any>;
const setupError = 'Routing pause is not configured. Use Pause once to authorize its setup.';

export async function readConfig(paths: Paths): Promise<Config> {
  try { return JSON.parse(await readFile(paths.config, 'utf8')); }
  catch { throw new Error('Routing pause requires a readable JSON configuration.'); }
}
function controller(config: Config): { url: string; secret: string } {
  const api = config.experimental?.clash_api;
  // Never send the private API credential to a non-loopback host or redirect.
  if (!api || typeof api.external_controller !== 'string' || !/^(127\.0\.0\.1|\[::1\]):\d+$/.test(api.external_controller)) {
    throw new Error('Routing pause requires a loopback Clash API controller (127.0.0.1 or ::1).');
  }
  return { url: `http://${api.external_controller}`, secret: api.secret || '' };
}
function routeRules() {
  return [
    { clash_mode: PAUSED_MODE, port: 53, action: 'hijack-dns' },
    { clash_mode: PAUSED_MODE, action: 'route', outbound: DIRECT },
  ];
}
function dnsRule() { return { clash_mode: PAUSED_MODE, action: 'route', server: DNS, disable_cache: true }; }
function pauseDnsRules(config: Config): Config[] {
  // Local host records remain valid when routing changes. Sending these names
  // upstream can create an OS/browser negative cache that outlives Pause.
  const hosts = (config.dns?.servers || []).filter((server: Config) => server.type === 'hosts' && server.tag);
  return [...hosts.map((server: Config) => ({
    clash_mode: PAUSED_MODE, preferred_by: server.tag, action: 'route', server: server.tag,
  })), dnsRule()];
}
function matches(value: Config | undefined, expected: Config): boolean {
  return !!value && Object.keys(value).length === Object.keys(expected).length
    && Object.keys(expected).every(key => value[key] === expected[key]);
}
function dnsRulesOffset(config: Config, rules: Config[]): number {
  const existing: Config[] = config.dns?.rules || [];
  // Explicit DNS policies may precede the managed Pause block, for example a
  // private zone whose authoritative resolver must remain reachable in Pause.
  const offset = existing.findIndex(rule => rule.clash_mode === PAUSED_MODE);
  return offset >= 0 && rules.every((rule, index) => matches(existing[offset + index], rule)) ? offset : -1;
}
function preparedWithDnsRules(config: Config, rules: Config[]): boolean {
  return routeRules().every((rule, index) => matches(config.route?.rules?.[index], rule))
    && dnsRulesOffset(config, rules) >= 0
    && !!config.outbounds?.some((x: Config) => matches(x, { type: 'direct', tag: DIRECT, domain_resolver: DNS }))
    && !!config.dns?.servers?.some((x: Config) => matches(x, { type: 'local', tag: DNS }));
}
export function isPrepared(config: Config): boolean { return preparedWithDnsRules(config, pauseDnsRules(config)); }
function isLegacyPrepared(config: Config): boolean { return preparedWithDnsRules(config, [dnsRule()]); }
export async function routingPauseReady(paths: Paths, allowLegacy = false): Promise<boolean> {
  let config: Config;
  try { config = JSON.parse(await readFile(paths.config, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) return false; throw error; }
  if (!config || !(isPrepared(config) || allowLegacy && isLegacyPrepared(config))) return false;
  controller(config);
  return true;
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Cannot allocate the routing controller port.');
  return address.port;
}
export async function prepareRoutingConfig(paths: Paths): Promise<string> {
  const config = await readConfig(paths);
  if (isPrepared(config)) { controller(config); return JSON.stringify(config, null, 2) + '\n'; }
  if (isLegacyPrepared(config)) {
    controller(config);
    const offset = dnsRulesOffset(config, [dnsRule()]);
    config.dns.rules = [...config.dns.rules.slice(0, offset), ...pauseDnsRules(config), ...config.dns.rules.slice(offset + 1)];
    return JSON.stringify(config, null, 2) + '\n';
  }
  if (JSON.stringify(config).includes(`"clash_mode":"${PAUSED_MODE}"`) || config.outbounds?.some((x: Config) => x.tag === DIRECT)
      || config.dns?.servers?.some((x: Config) => x.tag === DNS)) throw new Error('Configuration uses reserved sbm pause names. Remove the conflicting entries before setup.');
  config.experimental ??= {};
  config.experimental.clash_api ??= {};
  const api = config.experimental.clash_api;
  if (!api.external_controller) api.external_controller = `127.0.0.1:${await freePort()}`;
  controller(config);
  api.secret ||= crypto.randomUUID();
  config.route ??= {};
  config.route.rules = [...routeRules(), ...(config.route.rules || [])];
  config.dns ??= {};
  if (!config.dns.servers?.length) config.route.default_domain_resolver ??= DNS;
  // Preserve the implicit first-server default when adding our resolver.
  config.dns.servers = [...(config.dns.servers || []), { type: 'local', tag: DNS }];
  config.dns.rules = [...pauseDnsRules(config), ...(config.dns.rules || [])];
  config.outbounds = [...(config.outbounds || []), { type: 'direct', tag: DIRECT, domain_resolver: DNS }];
  return JSON.stringify(config, null, 2) + '\n';
}

export class RoutingMode {
  constructor(readonly paths: Paths, readonly fetcher: typeof fetch = fetch) {}
  async pendingResume() { return !!await optionalRead(join(this.paths.base, 'routing-resume.json')); }
  private async request(path: string, method = 'GET', body?: string): Promise<Response> {
    const config = await readConfig(this.paths);
    if (!isPrepared(config) && !isLegacyPrepared(config)) throw new Error(setupError);
    const api = controller(config);
    let response: Response;
    try {
      response = await this.fetcher(api.url + path, {
        method, body, redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { 'Content-Type': 'application/json', ...(api.secret ? { Authorization: `Bearer ${api.secret}` } : {}) },
      });
    } catch { throw new Error('Cannot reach the sing-box routing controller. The service has not been stopped.'); }
    if (!response.ok) throw new Error(`Routing controller returned HTTP ${response.status}.`);
    return response;
  }
  async mode(): Promise<string> {
    const data = await (await this.request('/configs')).json() as { mode?: string };
    if (!data.mode) throw new Error('Routing controller returned no mode.');
    return data.mode;
  }
  async paused(): Promise<boolean> {
    if (!await routingPauseReady(this.paths, true)) return false;
    return await this.mode() === PAUSED_MODE;
  }
  async change(paused: boolean, preserveResume = false): Promise<void> {
    const before = await this.mode();
    const statePath = join(this.paths.base, 'routing-resume.json');
    let next = PAUSED_MODE;
    if (paused) {
      // Save before changing the mode; repeated Pause must not erase the resume mode.
      if (before !== PAUSED_MODE && !(preserveResume && await optionalRead(statePath))) await atomicWrite(statePath, JSON.stringify({ mode: before }) + '\n');
    } else {
      const saved = await optionalRead(statePath);
      if (before !== PAUSED_MODE && !saved) return;
      const config = await readConfig(this.paths);
      next = before !== PAUSED_MODE ? before : saved ? JSON.parse(saved.toString()).mode : config.experimental?.clash_api?.default_mode || 'rule';
      if (typeof next !== 'string' || !next || next === PAUSED_MODE) throw new Error('Invalid saved routing resume mode.');
    }
    await this.request('/configs', 'PATCH', JSON.stringify({ mode: next }));
    if (await this.mode() !== next) throw new Error('sing-box did not apply the requested routing mode.');
    // Existing TCP/UDP sessions must reconnect through the new route too.
    try { await this.request('/connections', 'DELETE'); }
    catch { throw new Error('Routing mode changed, but existing connections could not be closed. Retry the same action to close them.'); }
    if (!paused) await rm(statePath, { force: true });
  }
}
