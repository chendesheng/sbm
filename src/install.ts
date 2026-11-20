import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Service, errorMessage, coreVersion } from './service';
import { checked, exists, atomicWrite, optionalRead, restoreFile, run, type Runner } from './system';
import { download, type Downloader, type DownloadProgress } from './download';
import { defaultCacheRoot } from './cache';
import { withDataLock, type Owner } from './storage';
import { coreName, hostPlatform, isWindows, type PlatformKind } from './platform';

type Asset = { name: string; browser_download_url: string; digest?: string | null };
export type Release = { tag_name: string; draft: boolean; prerelease: boolean; assets: Asset[] };
export type PreparationOptions = {
  release?: Release;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  onStage?: (stage: string) => void;
};
export type Fetcher = (url: string) => Promise<Response>;
export const fetchRelease: Fetcher = async (url) => fetch(url, {
  headers: { 'User-Agent': 'sbm/0.1.1', Accept: 'application/vnd.github+json' },
  signal: AbortSignal.timeout(120_000),
});
export function releaseEndpoint(version?: string) {
  if (version && !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid version; expected e.g. 1.14.4.');
  return `https://api.github.com/repos/SagerNet/sing-box/releases/${version ? `tags/v${version.replace(/^v/, '')}` : 'latest'}`;
}
export function selectAsset(release: Release, arch: string, kind: PlatformKind = hostPlatform): { asset: Asset; version: string; folder: string; binary: string } {
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : undefined;
  if (!cpu) throw new Error(`Unsupported architecture: ${arch}`);
  const version = release.tag_name.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || release.draft) throw new Error('Invalid release metadata.');
  const windows = isWindows(kind);
  const folder = `sing-box-${version}-${windows ? 'windows' : 'darwin'}-${cpu}`;
  const asset = release.assets.find(a => a.name === `${folder}.${windows ? 'zip' : 'tar.gz'}`);
  if (!asset) throw new Error(`Official release has no ${cpu} ${windows ? 'Windows' : 'macOS'} archive.`);
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) throw new Error('Release has no published SHA-256 digest; refusing an unverified installation.');
  if (!asset.browser_download_url.startsWith('https://github.com/SagerNet/sing-box/releases/download/')) throw new Error('Unexpected release download URL.');
  return { asset, version, folder, binary: coreName(kind) };
}

function tarTool(kind: PlatformKind): string { return isWindows(kind) ? 'tar.exe' : '/usr/bin/tar'; }
function tarFlags(kind: PlatformKind): string { return isWindows(kind) ? '-xf' : '-xzf'; }
async function response(fetcher: Fetcher, url: string) {
  const result = await fetcher(url);
  if (!result.ok) throw new Error(`Download failed: HTTP ${result.status} from ${url}`);
  return result;
}
export async function install(service: Service, requested?: string, fetcher = fetchRelease, arch = process.arch, downloader: Downloader = download, cacheRoot = defaultCacheRoot()): Promise<string> {
  return withPreparedInstall(requested, directory => activatePreparedInstall(service, directory, arch), fetcher, arch, downloader, service.runner, cacheRoot, {}, service.paths.kind);
}

async function cachedArchive(asset: Asset, folder: string, downloader: Downloader, cacheRoot: string, options: PreparationOptions): Promise<Buffer> {
  const directory = join(cacheRoot, folder);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cached = join(directory, `${asset.digest!.slice(7).toLowerCase()}.tar.gz`);
  if (await exists(cached)) {
    const archive = await readFile(cached);
    let verified = false;
    try {
      verifyArchive(archive, asset);
      verified = true;
    } catch {
      console.log('Cached archive failed checksum verification; downloading it again.');
      await rm(cached, { force: true });
    }
    if (verified) {
      console.log(`Using cached archive: ${cached}`);
      options.onStage?.('Verifying cached download…');
      return archive;
    }
  }
  console.log(`Downloading ${asset.name}...`);
  options.onStage?.('Upgrading (0%)');
  const stage = await mkdtemp(join(directory, '.download-'));
  try {
    const candidate = join(stage, 'release.tar.gz');
    await downloader(asset.browser_download_url, candidate, { signal: options.signal, onProgress: options.onProgress });
    options.onStage?.('Verifying download…');
    const archive = await readFile(candidate);
    verifyArchive(archive, asset);
    await rename(candidate, cached);
    console.log(`Cached archive: ${cached}`);
    return archive;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

// Prepare in the caller's user cache and private temporary directory, never managed state.
export async function withPreparedInstall<T>(requested: string | undefined, activate: (directory: string) => Promise<T>, fetcher = fetchRelease, arch = process.arch, downloader: Downloader = download, runner: Runner = run, cacheRoot = defaultCacheRoot(), options: PreparationOptions = {}, kind: PlatformKind = hostPlatform): Promise<T> {
  if (options.signal?.aborted) throw new Error('Upgrade cancelled.');
  console.log(requested ? `Checking sing-box ${requested} release...` : 'Checking the latest stable sing-box release...');
  const metadata = options.release || await (await response(fetcher, releaseEndpoint(requested))).json() as Release;
  if (!requested && metadata.prerelease) throw new Error('Latest stable release unexpectedly resolves to a prerelease.');
  if (requested && metadata.tag_name !== `v${requested.replace(/^v/, '')}`) throw new Error('Release version does not match the requested version.');
  const { asset, version, folder, binary: name } = selectAsset(metadata, arch, kind);
  const archive = await cachedArchive(asset, folder, downloader, cacheRoot, options);
  if (options.signal?.aborted) throw new Error('Upgrade cancelled.');
  const stage = await mkdtemp(join(tmpdir(), 'sbm-download-'));
  try {
    const archivePath = join(stage, 'release.tar.gz');
    await atomicWrite(archivePath, archive);
    await mkdir(join(stage, 'extracted'));
    await checked(runner, [tarTool(kind), tarFlags(kind), archivePath, '-C', join(stage, 'extracted'), `${folder}/${name}`]);
    const binary = join(stage, 'extracted', folder, name);
    if (!(await lstat(binary)).isFile()) throw new Error('Release executable is not a regular file.');
    if (!isWindows(kind)) await chmod(binary, 0o755);
    if (await coreVersion(runner, binary) !== version) throw new Error('Downloaded core reports an unexpected version.');
    await atomicWrite(join(stage, 'release.json'), JSON.stringify(metadata));
    console.log(`Verified sing-box ${version}.`);
    if (options.signal?.aborted) throw new Error('Upgrade cancelled.');
    return await activate(stage);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

function verifyArchive(archive: Uint8Array, asset: Asset) {
  const digest = createHash('sha256').update(archive).digest('hex');
  if (`sha256:${digest}` !== asset.digest?.toLowerCase()) throw new Error('Archive SHA-256 mismatch; existing installation left unchanged.');
}

async function preparedVersion(directory: string, arch: string, kind: PlatformKind): Promise<string> {
  const metadata = JSON.parse((await readFile(join(directory, 'release.json'))).toString()) as Release;
  return selectAsset(metadata, arch, kind).version;
}

export async function activatePreparedAsUser(service: Service, directory: string, owner: Owner, authorize: () => Promise<number>, arch = process.arch): Promise<number> {
  let needsRoot = false;
  // The privileged retry takes the same lock and revalidates its own snapshot.
  // Never hold the user lock while waiting for the sudo child to acquire it.
  await withDataLock(service.paths, owner, async () => {
    const state = await service.state();
    const current = await exists(service.paths.core) && await service.version() === await preparedVersion(directory, arch, service.paths.kind);
    if (state.loaded && !current) needsRoot = true;
    else console.log(await activatePreparedInstall(service, directory, arch));
  });
  return needsRoot ? authorize() : 0;
}

// Called after elevation. Snapshot and recheck the archive before using it as root.
export async function activatePreparedInstall(service: Service, directory: string, arch = process.arch): Promise<string> {
  const metadata = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')) as Release;
  const kind = service.paths.kind;
  const { asset, version, folder, binary: name } = selectAsset(metadata, arch, kind);
  const archive = await readFile(join(directory, 'release.tar.gz'));
  verifyArchive(archive, asset);
  const p = service.paths;
  if (await exists(p.core) && await service.version() === version) return `sing-box ${version} is already installed.`;
  await p.prepare();
  console.log(`Installing sing-box ${version}...`);
  const stage = await mkdtemp(join(p.base, '.install-'));
  try {
    const archivePath = join(stage, 'release.tar.gz');
    await atomicWrite(archivePath, archive);
    await mkdir(join(stage, 'extracted'));
    await checked(service.runner, [tarTool(kind), tarFlags(kind), archivePath, '-C', join(stage, 'extracted'), `${folder}/${name}`]);
    const binary = join(stage, 'extracted', folder, name);
    if (!(await lstat(binary)).isFile()) throw new Error('Release executable is not a regular file.');
    if (!isWindows(kind)) await chmod(binary, 0o755);
    if (await service.version(binary) !== version) throw new Error('Downloaded core reports an unexpected version.');
    if (await exists(p.config)) await service.validate(binary);
    const old = await optionalRead(p.core);
    const before = await service.state();
    const wasPaused = !!before.pid && await service.routingPaused();
    if (before.loaded) await service.stop();
    try {
      if (old) await atomicWrite(`${p.core}.previous`, old, 0o755);
      await rename(binary, p.core);
      if (before.loaded) { await service.launch(); if (wasPaused) await service.pause(true); }
    } catch (error) {
      try {
        await service.stop();
        await restoreFile(p.core, old, 0o755);
        if (before.loaded && old) { await service.launch(); if (wasPaused) await service.pause(true); }
      } catch (rollback) {
        throw new Error(`${errorMessage(error)} Rollback failed: ${errorMessage(rollback)}`);
      }
      throw new Error(`${errorMessage(error)} Previous core and running state restored.`);
    }
    return `sing-box ${version} installed${before.loaded ? ' and restarted' : ''}.`;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
