import { setTimeout as sleep } from 'node:timers/promises';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Paths, type Runner, checked, exists, atomicWrite, optionalRead, restoreFile } from './system';
import { RoutingMode, routingPauseReady, prepareRoutingConfig } from './routing-mode';

export type ServiceState = { loaded: boolean; pid?: number; state: string };
export async function coreVersion(runner: Runner, core: string): Promise<string> {
  const output = await checked(runner, [core, 'version']);
  const version = output.match(/sing-box version (\S+)/)?.[1];
  if (!version) throw new Error('Could not determine sing-box version.');
  return version;
}
export function plist(paths: Paths): string {
  const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  const text = (s: string) => `<string>${xml(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key>${text(paths.label)}
<key>ProgramArguments</key><array>${[paths.core, 'run', '-D', paths.base, '-c', paths.config].map(text).join('')}</array>
<key>WorkingDirectory</key>${text(paths.base)}
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key>${text(paths.stdout)}<key>StandardErrorPath</key>${text(paths.stderr)}
</dict></plist>\n`;
}
export class Service {
  constructor(readonly paths: Paths, readonly runner: Runner, readonly timing = { attempts: 50, interval: 200, stableSamples: 5 }) {}
  async state(): Promise<ServiceState> {
    const r = await this.runner(['/bin/launchctl', 'print', this.paths.target]);
    if (r.code !== 0) {
      if (/Could not find service|service not found|No such process/i.test(r.stderr + r.stdout)) return { loaded: false, state: 'paused' };
      throw new Error(`Cannot read launchd state: ${r.stderr || r.stdout}`);
    }
    const pid = r.stdout.match(/^\s*pid = (\d+)$/m);
    return { loaded: true, pid: pid ? Number(pid[1]) : undefined, state: r.stdout.match(/^\s*state = (.+)$/m)?.[1] || 'loaded' };
  }
  async requireCore() {
    if (!await exists(this.paths.core)) throw new Error('sing-box is not installed. Run sbm install first.');
  }
  async validate(core = this.paths.core, config = this.paths.config) {
    if (!await exists(config)) throw new Error('No saved configuration. Run sbm start --config <file>.');
    await checked(this.runner, [core, 'check', '-D', this.paths.base, '-c', config]);
  }
  async version(core = this.paths.core): Promise<string> {
    return coreVersion(this.runner, core);
  }
  async configuredLogPath(): Promise<string | undefined> {
    const bytes = await optionalRead(this.paths.config);
    if (!bytes) return;
    // The core may also accept commented JSON. Status remains available in that case.
    try {
      const config = JSON.parse(bytes.toString()) as { log?: { output?: string } };
      if (config.log?.output) return resolve(this.paths.base, config.log.output);
    } catch { /* Service stdout/stderr locations are still reported. */ }
  }
  async routingPauseReady() { return routingPauseReady(this.paths); }
  async routingPaused() { return new RoutingMode(this.paths).paused(); }
  async pause(preserveResume = false) {
    if (!(await this.state()).loaded) return;
    await new RoutingMode(this.paths).change(true, preserveResume);
  }
  async prepareRoutingPause() {
    if (await this.routingPauseReady()) return;
    const candidate = `${this.paths.config}.${crypto.randomUUID()}.pause-setup`;
    try {
      await atomicWrite(candidate, await prepareRoutingConfig(this.paths));
      await this.start(candidate);
    } finally { await rm(candidate, { force: true }); }
  }
  // Lifecycle operations still need to unload the core before replacing files.
  async stop() {
    if (!(await this.state()).loaded) return;
    await checked(this.runner, ['/bin/launchctl', 'bootout', this.paths.target]);
    for (let n = 0; n < this.timing.attempts; n++) {
      if (!(await this.state()).loaded) return;
      await sleep(this.timing.interval);
    }
    throw new Error('Timed out waiting for sing-box to stop.');
  }
  async launch() {
    await mkdir(this.paths.systemBase, { recursive: true, mode: 0o755 });
    await atomicWrite(this.paths.plist, plist(this.paths));
    await checked(this.runner, ['/bin/launchctl', 'enable', this.paths.target]);
    await checked(this.runner, ['/bin/launchctl', 'bootstrap', this.paths.domain, this.paths.plist]);
    let lastPid: number | undefined;
    let stable = 0;
    for (let n = 0; n < this.timing.attempts; n++) {
      const current = await this.state();
      stable = current.pid && current.pid === lastPid ? stable + 1 : 0;
      lastPid = current.pid;
      if (stable >= this.timing.stableSamples) return;
      await sleep(this.timing.interval);
    }
    throw new Error(`sing-box did not remain running. See ${this.paths.stderr}`);
  }
  async start(source?: string): Promise<string> {
    await this.requireCore();
    const before = await this.state();
    if (!source && before.pid) {
      const routing = new RoutingMode(this.paths);
      if (await this.routingPauseReady() && (await routing.paused() || await routing.pendingResume())) {
        await routing.change(false);
        return 'sing-box resumed. Normal routing restored.';
      }
      return 'sing-box is already running.';
    }
    const wasPaused = !!before.pid && await this.routingPaused();
    const old = await optionalRead(this.paths.config);
    const candidate = `${this.paths.config}.${crypto.randomUUID()}.candidate`;
    try {
      if (source) {
        // Check the exact bytes that will be saved, in the service working directory.
        await atomicWrite(candidate, await readFile(source));
        await this.validate(this.paths.core, candidate);
      } else await this.validate();
      if (old && source) await atomicWrite(`${this.paths.config}.previous`, old);
      if (before.loaded) await this.stop();
      try {
        if (source) await atomicWrite(this.paths.config, await readFile(candidate));
        await this.launch();
        if (await this.routingPaused()) await new RoutingMode(this.paths).change(false);
      } catch (error) {
        try {
          await this.stop();
          await restoreFile(this.paths.config, old);
          if (before.loaded && old) {
            await this.launch();
            if (wasPaused) await this.pause(true);
          }
        } catch (rollback) {
          throw new Error(`${errorMessage(error)} Rollback failed: ${errorMessage(rollback)}`);
        }
        throw new Error(`${errorMessage(error)} Previous configuration and running state restored.`);
      }
      return 'sing-box started.';
    } finally { await rm(candidate, { force: true }); }
  }
  async enable() {
    await this.requireCore();
    await this.validate();
    await mkdir(dirname(this.paths.bootPlist), { recursive: true });
    await atomicWrite(this.paths.bootPlist, plist(this.paths), 0o644);
  }
  async disable() { await rm(this.paths.bootPlist, { force: true }); }
}
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
