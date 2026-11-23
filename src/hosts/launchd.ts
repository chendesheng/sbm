import { rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Paths, type Runner, atomicWrite, checked, exists } from '../system';
import type { ServiceHost, ServiceState } from './types';
import { launchdLogArguments } from './launchd-logs';

export function plist(paths: Paths): string {
  const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  const text = (s: string) => `<string>${xml(s)}</string>`;
  const args = launchdLogArguments(paths.stdout, paths.stderr, [paths.core, 'run', '-D', paths.base, '-c', paths.config]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key>${text(paths.label)}
<key>ProgramArguments</key><array>${args.map(text).join('')}</array>
<key>WorkingDirectory</key>${text(paths.base)}
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key>${text(paths.stdout)}<key>StandardErrorPath</key>${text(paths.stderr)}
</dict></plist>\n`;
}

export class LaunchdHost implements ServiceHost {
  constructor(readonly paths: Paths, readonly runner: Runner) {}

  async state(): Promise<ServiceState> {
    const r = await this.runner(['/bin/launchctl', 'print', this.paths.target]);
    if (r.code !== 0) {
      if (/Could not find service|service not found|No such process/i.test(r.stderr + r.stdout)) return { loaded: false, state: 'paused' };
      throw new Error(`Cannot read launchd state: ${r.stderr || r.stdout}`);
    }
    const pid = r.stdout.match(/^\s*pid = (\d+)$/m);
    return { loaded: true, pid: pid ? Number(pid[1]) : undefined, state: r.stdout.match(/^\s*state = (.+)$/m)?.[1] || 'loaded' };
  }

  async start(): Promise<void> {
    await mkdir(this.paths.systemBase, { recursive: true, mode: 0o755 });
    const definition = plist(this.paths);
    await atomicWrite(this.paths.plist, definition);
    if (await this.bootEnabled()) await atomicWrite(this.paths.bootPlist, definition, 0o644);
    await checked(this.runner, ['/bin/launchctl', 'enable', this.paths.target]);
    await checked(this.runner, ['/bin/launchctl', 'bootstrap', this.paths.domain, this.paths.plist]);
  }

  async stop(): Promise<void> {
    await checked(this.runner, ['/bin/launchctl', 'bootout', this.paths.target]);
  }

  async bootEnabled(): Promise<boolean> {
    return exists(this.paths.bootPlist);
  }

  async enableBoot(): Promise<void> {
    await mkdir(dirname(this.paths.bootPlist), { recursive: true });
    await atomicWrite(this.paths.bootPlist, plist(this.paths), 0o644);
  }

  async disableBoot(): Promise<void> {
    await rm(this.paths.bootPlist, { force: true });
  }
}
