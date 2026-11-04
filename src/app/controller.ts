import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Service, errorMessage } from '../service';
import { exists } from '../system';
import { requireOwner, type Owner } from '../storage';
import { activatePreparedAsUser, fetchRelease, releaseEndpoint, selectAsset, withPreparedInstall, type Fetcher, type Release } from '../install';
import { download, type Downloader } from '../download';
import { defaultCacheRoot } from '../cache';

export type AppStatus = 'running' | 'paused' | 'waiting' | 'unknown';
export type AppModel = { status: AppStatus; version: string; busy: boolean; loaded: boolean; canStart: boolean; canUpgrade: boolean; upgradeLabel: string };
export type AppAction = 'start' | 'pause' | 'upgrade';
export type Authorize = (action: AppAction, preparedDirectory: string) => Promise<number>;
export class AuthorizationCancelled extends Error {}

export function newerVersion(candidate: string, installed: string): boolean {
  const parts = (version: string) => version.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const a = parts(candidate), b = parts(installed);
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some(n => !Number.isFinite(n))) throw new Error('Cannot compare sing-box versions.');
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return !candidate.includes('-') && installed.includes('-');
}

export class AppController {
  readonly model: AppModel = { status: 'unknown', version: 'Checking…', busy: false, loaded: false, canStart: false, canUpgrade: false, upgradeLabel: 'Checking…' };
  readonly abort = new AbortController();
  private stamp = -1;
  private refreshing = false;
  private canManage = false;
  private checkSequence = 0;
  private checking = false;
  private checkFailed = false;
  private release?: Release;
  private releaseVersion?: string;
  constructor(
    readonly service: Service,
    readonly owner: Owner,
    readonly authorize: Authorize,
    readonly render: (model: AppModel) => void,
    readonly alert: (message: string, error: boolean) => void,
    readonly fetcher: Fetcher = fetchRelease,
    readonly downloader: Downloader = download,
    readonly cacheRoot = defaultCacheRoot(),
    readonly arch = process.arch,
  ) {}

  private publish() {
    if (!this.model.busy) {
      let available = false, failed = this.checkFailed;
      try {
        available = this.releaseVersion !== undefined && (this.model.version === 'Not installed'
          || this.model.version !== 'Checking…' && newerVersion(this.releaseVersion, this.model.version));
      } catch { failed = true; }
      this.model.canUpgrade = this.canManage && !this.checking && !failed && available;
      this.model.upgradeLabel = this.checking ? 'Checking…' : failed ? 'Update check failed'
        : this.releaseVersion === undefined ? 'Checking…' : available ? `Upgrade to ${this.releaseVersion}` : 'No new version';
    }
    this.render(this.model);
  }
  private stage(label: string) { this.model.upgradeLabel = label; this.publish(); }
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const state = await this.service.state();
      this.model.loaded = state.loaded;
      this.model.status = state.pid ? 'running' : state.loaded ? 'waiting' : 'paused';
      const installed = await exists(this.service.paths.core);
      if (installed) {
        const stamp = (await stat(this.service.paths.core)).mtimeMs;
        if (stamp !== this.stamp) { this.model.version = await this.service.version(); this.stamp = stamp; }
      } else { this.model.version = 'Not installed'; this.stamp = -1; }
      this.model.canStart = state.loaded || installed && await exists(this.service.paths.config);
      const uid = process.getuid?.() ?? 0;
      this.canManage = uid === 0 || uid === this.owner.uid;
      this.model.canStart = this.model.canStart && this.canManage;
    } catch {
      this.model.status = 'unknown'; this.model.canStart = false; this.canManage = false;
    } finally { this.refreshing = false; this.publish(); }
  }

  async checkForUpdates(): Promise<void> {
    const sequence = ++this.checkSequence;
    this.checking = true; this.checkFailed = false; this.publish();
    try {
      const release = await this.latestRelease();
      const selected = selectAsset(release, this.arch);
      // Read the core again so CLI upgrades are reflected on the next opening.
      const version = await exists(this.service.paths.core) ? await this.service.version() : 'Not installed';
      if (version !== 'Not installed') newerVersion(selected.version, version);
      if (sequence !== this.checkSequence) return;
      this.model.version = version;
      this.release = release; this.releaseVersion = selected.version;
    } catch {
      if (sequence === this.checkSequence) this.checkFailed = true;
    } finally {
      if (sequence === this.checkSequence) { this.checking = false; this.publish(); }
    }
  }

  private async latestRelease(): Promise<Release> {
    const response = await this.fetcher(releaseEndpoint());
    if (!response.ok) throw new Error(`Update check failed: HTTP ${response.status}.`);
    const release = await response.json() as Release;
    if (release.prerelease) throw new Error('The latest release is not a stable release.');
    return release;
  }

  async changeState(action: 'start' | 'pause'): Promise<void> {
    if (this.model.busy) return;
    this.model.busy = true; this.publish();
    try {
      requireOwner(this.owner);
      const state = await this.service.state();
      if (action === 'start' && state.pid || action === 'pause' && !state.loaded) return;
      if (action === 'start') { await this.service.requireCore(); await this.service.validate(); }
      await this.authorize(action, '');
    } catch (error) { if (!(error instanceof AuthorizationCancelled)) this.alert(errorMessage(error), true); }
    finally { this.model.busy = false; await this.refresh(); }
  }

  async upgrade(): Promise<void> {
    if (this.model.busy) return;
    this.model.busy = true; this.stage('Checking for updates…');
    try {
      requireOwner(this.owner);
      const release = this.release || await this.latestRelease();
      const selected = selectAsset(release, this.arch);
      this.release = release; this.releaseVersion = selected.version;
      if (await exists(this.service.paths.core) && !newerVersion(selected.version, await this.service.version())) {
        this.alert('sing-box is already up to date.', false); return;
      }
      await withPreparedInstall(undefined, async directory => {
        if (this.abort.signal.aborted) throw new AuthorizationCancelled();
        // Validate the saved config before asking for privileges; activation
        // rechecks the exact archive/config and the running state under its lock.
        if (await exists(this.service.paths.config)) await this.service.validate(join(directory, 'extracted', selected.folder, 'sing-box'));
        this.stage('Applying upgrade…');
        return activatePreparedAsUser(this.service, directory, this.owner, async () => {
          this.stage('Waiting for authorization…');
          return this.authorize('upgrade', directory);
        }, this.arch);
      }, this.fetcher, this.arch, this.downloader, this.service.runner, this.cacheRoot, {
        release, signal: this.abort.signal,
        onStage: label => this.stage(label),
        onProgress: progress => {
          const label = progress.totalBytes ? `${Math.min(100, Math.floor(progress.receivedBytes * 100 / progress.totalBytes))}%` : `${(progress.receivedBytes / 1024 / 1024).toFixed(1)} MB`;
          this.stage(`Upgrading (${label})`);
        },
      });
    } catch (error) { if (!(error instanceof AuthorizationCancelled) && !this.abort.signal.aborted) this.alert(errorMessage(error), true); }
    finally { this.model.busy = false; this.stamp = -1; await this.refresh(); }
  }
}
