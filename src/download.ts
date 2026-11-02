import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';

export type Downloader = (url: string, destination: string) => Promise<void>;

export const download: Downloader = async (url, destination) => {
  await writeFile(destination, '', { mode: 0o600, flag: 'wx' });
  try {
    // Leave stderr attached so curl displays its default progress meter.
    const child = spawn('/usr/bin/curl', [
      '--fail', '--location', '--show-error',
      '--proto', '=https', '--proto-redir', '=https',
      '--connect-timeout', '20', '--max-time', '120',
      '--output', destination, '--url', url,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    const code = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => resolve(code ?? 1));
    });
    if (code !== 0) throw new Error(`curl download failed (exit ${code}).`);
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
};
