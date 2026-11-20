import { setTimeout as sleep } from 'node:timers/promises';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Paths, type Runner, checked, exists, atomicWrite, optionalRead, restoreFile } from './system';
import { RoutingMode, routingPauseReady, prepareRoutingConfig } from './routing-mode';
import { createServiceHost, type ServiceHost } from './hosts';

export type { ServiceState } from './hosts/types';
export { plist } from './hosts/launchd';

export async function coreVersion(runner: Runner, core: string): Promise<string> {
  const output = await checked(runner, [core, 'version']);
  const version = output.match(/sing-box version (\S+)/)?.[1];
  if (!version) throw new Error('Could not determine sing-box version.');
  return version;
}

export class Service {
  readonly host: ServiceHost;
  constructor(readonly paths: Paths, readonly runner: Runner, readonly timing = { attempts: 50, interval: 200, stableSamples: 5 }) {
    this.host = createServiceHost(paths, runner);
  }

  async state() { return this.host.state(); }

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

  // Lifecycle operations still need to stop the core before replacing files.
  async stop() {
    if (!(await this.state()).loaded) return;
    await this.host.stop();
    for (let n = 0; n < this.timing.attempts; n++) {
      if (!(await this.state()).loaded) return;
      await sleep(this.timing.interval);
    }
    throw new Error('Timed out waiting for sing-box to stop.');
  }

  async launch() {
    await this.host.start();
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
      if (await routingPauseReady(this.paths, true) && (await routing.paused() || await routing.pendingResume())) {
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
    await this.host.enableBoot();
  }

  async disable() { await this.host.disableBoot(); }

  async bootEnabled(): Promise<boolean> { return this.host.bootEnabled(); }
}

export function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
