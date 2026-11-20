import { homedir } from 'node:os';
import { join } from 'node:path';

// sbm runs as a launchd system service on macOS and as an unprivileged,
// per-user process on Windows. The Windows layout therefore never touches
// ProgramData, the Service Control Manager, or an elevated token.
export type PlatformKind = 'macos' | 'windows';

export const hostPlatform: PlatformKind = process.platform === 'win32' ? 'windows' : 'macos';

export function isWindows(kind: PlatformKind = hostPlatform): boolean { return kind === 'windows'; }
export function isMacos(kind: PlatformKind = hostPlatform): boolean { return kind === 'macos'; }

// Only the macOS design owns a root service account. Windows operations run
// with the invoking user's token, so nothing needs sudo or a UAC prompt.
export function isPrivileged(kind: PlatformKind = hostPlatform): boolean {
  if (isWindows(kind)) return true;
  return process.getuid?.() === 0;
}

function environmentPath(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export function localAppData(home = homedir()): string {
  return environmentPath('LOCALAPPDATA', join(home, 'AppData', 'Local'));
}

export function roamingAppData(home = homedir()): string {
  return environmentPath('APPDATA', join(home, 'AppData', 'Roaming'));
}

export function defaultUserRoot(kind: PlatformKind = hostPlatform, home = homedir()): string {
  return isWindows(kind) ? join(localAppData(home), 'sbm') : join(home, 'Library', 'Application Support', 'sbm');
}

export function defaultSystemRoot(kind: PlatformKind = hostPlatform, base = defaultUserRoot(kind)): string {
  return isWindows(kind) ? base : '/Library/Application Support/sbm';
}

// Windows has no boot-time registration without administrator rights, so
// "boot startup" is the per-user Startup folder and begins at sign-in.
export function defaultBootDir(kind: PlatformKind = hostPlatform, home = homedir()): string {
  return isWindows(kind)
    ? join(roamingAppData(home), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    : '/Library/LaunchDaemons';
}

export function defaultCacheRoot(kind: PlatformKind = hostPlatform, home = homedir()): string {
  return isWindows(kind) ? join(localAppData(home), 'sbm', 'cache') : join(home, 'Library', 'Caches', 'sbm');
}

export function coreName(kind: PlatformKind = hostPlatform): string {
  return isWindows(kind) ? 'sing-box.exe' : 'sing-box';
}

export function startupScriptName(): string { return 'sbm-sing-box.vbs'; }
export function runStateName(): string { return 'run.json'; }
