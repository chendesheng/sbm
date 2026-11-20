import { Service } from './service';
import { isWindows } from './platform';
import { exists } from './system';
import { statusCacheRoot, cacheSize, formatCacheSize } from './cache';

async function readable<T>(action: () => Promise<T>, fallback: T): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) return fallback;
    throw error;
  }
}

// Reading the host's state does not require access to the private data directory.
export async function statusText(service: Service, legacy = false): Promise<string> {
  const paths = service.paths;
  const state = await service.state();
  const routing = state.pid ? await service.routingPaused().catch(() => undefined) : false;
  const stateLabel = state.pid
    ? routing === undefined ? 'running (routing unknown)' : routing ? 'paused (direct routing; core running)' : 'running'
    : state.loaded ? state.state : 'paused';
  const unavailable = legacy ? 'unavailable (one-time storage migration required)' : 'unavailable (private to the service owner)';
  const bootLabel = isWindows(paths.kind) ? 'Start at sign-in' : 'Boot startup';
  const core = await readable(async () => await exists(paths.core) ? service.version() : 'not installed', unavailable);
  const configuredLog = await readable(() => service.configuredLogPath(), undefined);
  const saved = await readable(async () => await exists(paths.config) ? '' : ' (not saved)', ' (unavailable)');
  const cache = await statusCacheRoot();
  let size: string;
  try { size = formatCacheSize(await cacheSize(cache)); }
  catch { size = 'unavailable'; }
  return [
    `Core: ${core}`,
    `State: ${stateLabel}${state.pid ? ` (PID ${state.pid})` : ''}`,
    `${bootLabel}: ${(await service.bootEnabled()) ? 'enabled' : 'disabled'}`,
    `Config: ${paths.config}${saved}`,
    `Stdout log: ${paths.stdout}`, `Stderr log: ${paths.stderr}`,
    ...(configuredLog ? [`Configured core log: ${configuredLog}`] : []),
    `Cache folder: ${cache}`, `Cache size: ${size}`,
  ].join('\n');
}
