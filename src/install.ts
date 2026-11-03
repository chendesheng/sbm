import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Service, errorMessage, coreVersion } from './service';
import { checked, exists, atomicWrite, optionalRead, restoreFile, run, type Runner } from './system';
import { download, type Downloader } from './download';
import { defaultCacheRoot } from './cache';
import { withDataLock, type Owner } from './storage';

type Asset = { name: string; browser_download_url: string; digest?: string | null };
type Release = { tag_name: string; draft: boolean; prerelease: boolean; assets: Asset[] };
export type Fetcher = (url: string) => Promise<Response>;
export const fetchRelease: Fetcher = async (url) => fetch(url, {
  headers: { 'User-Agent': 'sbm/0.1.0', Accept: 'application/vnd.github+json' },
  signal: AbortSignal.timeout(120_000),
});
export function releaseEndpoint(version?: string) {
  if (version && !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid version; expected e.g. 1.14.4.');
  return `https://api.github.com/repos/SagerNet/sing-box/releases/${version ? `tags/v${version.replace(/^v/, '')}` : 'latest'}`;
}
export function selectAsset(release: Release, arch: string): { asset: Asset; version: string; folder: string } {
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : undefined;
  if (!cpu) throw new Error(`Unsupported architecture: ${arch}`);
  const version = release.tag_name.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || release.draft) throw new Error('Invalid release metadata.');
  const folder = `sing-box-${version}-darwin-${cpu}`;
  const asset = release.assets.find(a => a.name === `${folder}.tar.gz`);
  if (!asset) throw new Error(`Official release has no ${cpu} macOS archive.`);
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) throw new Error('Release has no published SHA-256 digest; refusing an unverified installation.');
  if (!asset.browser_download_url.startsWith('https://github.com/SagerNet/sing-box/releases/download/')) throw new Error('Unexpected release download URL.');
  return { asset, version, folder };
}
async function response(fetcher: Fetcher, url: string) {
  const result = await fetcher(url);
  if (!result.ok) throw new Error(`Download failed: HTTP ${result.status} from ${url}`);
  return result;
}
export async function install(service: Service, requested?: string, fetcher = fetchRelease, arch = process.arch, downloader: Downloader = download, cacheRoot = defaultCacheRoot()): Promise<string> {
  return withPreparedInstall(requested, directory => activatePreparedInstall(service, directory, arch), fetcher, arch, downloader, service.runner, cacheRoot);
}

async function cachedArchive(asset: Asset, folder: string, downloader: Downloader, cacheRoot: string): Promise<Buffer> {
  const directory = join(cacheRoot, folder);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cached = join(directory, `${asset.digest!.slice(7).toLowerCase()}.tar.gz`);
  if (await exists(cached)) {
    const archive = await readFile(cached);
    try {
      verifyArchive(archive, asset);
      console.log(`Using cached archive: ${cached}`);
      return archive;
    } catch {
      console.log('Cached archive failed checksum verification; downloading it again.');
      await rm(cached, { force: true });
    }
  }
  console.log(`Downloading ${asset.name}...`);
  const stage = await mkdtemp(join(directory, '.download-'));
  try {
    const candidate = join(stage, 'release.tar.gz');
    await downloader(asset.browser_download_url, candidate);
    const archive = await readFile(candidate);
    verifyArchive(archive, asset);
    await rename(candidate, cached);
    console.log(`Cached archive: ${cached}`);
    return archive;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

// Prepare in the caller's user cache and private temporary directory, never managed state.
export async function withPreparedInstall<T>(requested: string | undefined, activate: (directory: string) => Promise<T>, fetcher = fetchRelease, arch = process.arch, downloader: Downloader = download, runner: Runner = run, cacheRoot = defaultCacheRoot()): Promise<T> {
  console.log(requested ? `Checking sing-box ${requested} release...` : 'Checking the latest stable sing-box release...');
  const metadata = await (await response(fetcher, releaseEndpoint(requested))).json() as Release;
  if (!requested && metadata.prerelease) throw new Error('Latest stable release unexpectedly resolves to a prerelease.');
  if (requested && metadata.tag_name !== `v${requested.replace(/^v/, '')}`) throw new Error('Release version does not match the requested version.');
  const { asset, version, folder } = selectAsset(metadata, arch);
  const archive = await cachedArchive(asset, folder, downloader, cacheRoot);
  const stage = await mkdtemp(join(tmpdir(), 'sbm-download-'));
  try {
    const archivePath = join(stage, 'release.tar.gz');
    await atomicWrite(archivePath, archive);
    await mkdir(join(stage, 'extracted'));
    await checked(runner, ['/usr/bin/tar', '-xzf', archivePath, '-C', join(stage, 'extracted'), `${folder}/sing-box`]);
    const binary = join(stage, 'extracted', folder, 'sing-box');
    if (!(await lstat(binary)).isFile()) throw new Error('Release executable is not a regular file.');
    await chmod(binary, 0o755);
    if (await coreVersion(runner, binary) !== version) throw new Error('Downloaded core reports an unexpected version.');
    await atomicWrite(join(stage, 'release.json'), JSON.stringify(metadata));
    console.log(`Verified sing-box ${version}.`);
    return await activate(stage);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

function verifyArchive(archive: Uint8Array, asset: Asset) {
  const digest = createHash('sha256').update(archive).digest('hex');
  if (`sha256:${digest}` !== asset.digest?.toLowerCase()) throw new Error('Archive SHA-256 mismatch; existing installation left unchanged.');
}

async function preparedVersion(directory: string, arch: string): Promise<string> {
  const metadata = JSON.parse((await readFile(join(directory, 'release.json'))).toString()) as Release;
  return selectAsset(metadata, arch).version;
}

export async function activatePreparedAsUser(service: Service, directory: string, owner: Owner, authorize: () => Promise<number>, arch = process.arch): Promise<number> {
  let needsRoot = false;
  // The privileged retry takes the same lock and revalidates its own snapshot.
  // Never hold the user lock while waiting for the sudo child to acquire it.
  await withDataLock(service.paths, owner, async () => {
    const state = await service.state();
    const current = await exists(service.paths.core) && await service.version() === await preparedVersion(directory, arch);
    if (state.loaded && !current) needsRoot = true;
    else console.log(await activatePreparedInstall(service, directory, arch));
  });
  return needsRoot ? authorize() : 0;
}

// Called after elevation. Snapshot and recheck the archive before using it as root.
export async function activatePreparedInstall(service: Service, directory: string, arch = process.arch): Promise<string> {
  const metadata = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')) as Release;
  const { asset, version, folder } = selectAsset(metadata, arch);
  const archive = await readFile(join(directory, 'release.tar.gz'));
  verifyArchive(archive, asset);
  const p = service.paths;
  if (await exists(p.core) && await service.version() === version) return `sing-box ${version} is already installed.`;
  console.log(`Installing sing-box ${version}...`);
  const stage = await mkdtemp(join(p.base, '.install-'));
  try {
    const archivePath = join(stage, 'release.tar.gz');
    await atomicWrite(archivePath, archive);
    await mkdir(join(stage, 'extracted'));
    await checked(service.runner, ['/usr/bin/tar', '-xzf', archivePath, '-C', join(stage, 'extracted'), `${folder}/sing-box`]);
    const binary = join(stage, 'extracted', folder, 'sing-box');
    if (!(await lstat(binary)).isFile()) throw new Error('Release executable is not a regular file.');
    await chmod(binary, 0o755);
    if (await service.version(binary) !== version) throw new Error('Downloaded core reports an unexpected version.');
    if (await exists(p.config)) await service.validate(binary);
    const old = await optionalRead(p.core);
    const before = await service.state();
    if (before.loaded) await service.pause();
    try {
      if (old) await atomicWrite(`${p.core}.previous`, old, 0o755);
      await rename(binary, p.core);
      if (before.loaded) await service.launch();
    } catch (error) {
      try {
        await service.pause();
        await restoreFile(p.core, old, 0o755);
        if (before.loaded && old) await service.launch();
      } catch (rollback) {
        throw new Error(`${errorMessage(error)} Rollback failed: ${errorMessage(rollback)}`);
      }
      throw new Error(`${errorMessage(error)} Previous core and running state restored.`);
    }
    return `sing-box ${version} installed${before.loaded ? ' and restarted' : ''}.`;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
