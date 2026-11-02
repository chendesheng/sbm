import { rm, writeFile } from 'node:fs/promises';

export type Downloader = (url: string, destination: string) => Promise<void>;

export const download: Downloader = async (url, destination) => {
  await writeFile(destination, '', { mode: 0o600, flag: 'wx' });
  try {
    // Leave stderr attached so curl displays its default progress meter.
    const child = Bun.spawn([
      '/usr/bin/curl', '--fail', '--location', '--show-error',
      '--proto', '=https', '--proto-redir', '=https',
      '--connect-timeout', '20', '--max-time', '120',
      '--output', destination, '--url', url,
    ], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
    const code = await child.exited;
    if (code !== 0) throw new Error(`curl download failed (exit ${code}).`);
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
};
