import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { checked, run } from './system';

export function defaultCacheRoot() { return join(homedir(), 'Library/Caches/sbm'); }

export async function statusCacheRoot(): Promise<string> {
  // sudo replaces HOME; report the cache used by the original install caller.
  if (process.getuid?.() === 0 && process.env.SUDO_USER) {
    const output = await checked(run, ['/usr/bin/dscl', '.', '-read', `/Users/${process.env.SUDO_USER}`, 'NFSHomeDirectory']);
    const home = output.match(/^NFSHomeDirectory: (.+)$/m)?.[1];
    if (!home || !isAbsolute(home)) throw new Error('Cannot determine the invoking user\'s cache directory.');
    return join(home, 'Library/Caches/sbm');
  }
  return defaultCacheRoot();
}

export async function cacheSize(path: string): Promise<number> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return 0;
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    let total = 0;
    for (const name of await readdir(path)) total += await cacheSize(join(path, name));
    return total;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

export function formatCacheSize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return index === 0 ? `${bytes} B` : `${(bytes / 1024 ** index).toFixed(1)} ${units[index]} (${bytes} bytes)`;
}
