import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, checked, run } from '../src/system';
import { download } from '../src/download';

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('Compiler setup currently supports macOS arm64 and x64.');
const name = `bun-darwin-${process.arch === 'arm64' ? 'aarch64' : 'x64'}`;
async function get(url: string) {
  const response = await fetch(url, { headers: { 'User-Agent': 'sbm-build' }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response;
}
const release = await (await get('https://api.github.com/repos/oven-sh/bun/releases/tags/canary')).json() as {
  assets: { name: string; digest?: string; browser_download_url: string }[];
};
const asset = release.assets.find(a => a.name === `${name}.zip`);
if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || !asset.browser_download_url.startsWith('https://github.com/oven-sh/bun/releases/download/')) throw new Error('No checksum-verified official compiler archive found.');
const temp = await mkdtemp(join(tmpdir(), 'sbm-compiler-'));
try {
  const archive = join(temp, 'bun.zip');
  await download(asset.browser_download_url, archive);
  const bytes = await readFile(archive);
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) throw new Error('Compiler archive checksum mismatch.');
  const child = Bun.spawn(['/usr/bin/unzip', '-p', archive, `${name}/bun`], { stdout: 'pipe', stderr: 'pipe' });
  const [binary, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Cannot extract compiler: ${stderr}`);
  const candidate = join(temp, 'bun'); await atomicWrite(candidate, new Uint8Array(binary), 0o755);
  const help = await checked(run, [candidate, 'compile', '--help']);
  if (!help.includes('--no-aot')) throw new Error('The current canary does not expose native AOT.');
  const revision = (await checked(run, [candidate, '--revision'])).trim();
  await mkdir('.tools', { recursive: true });
  await atomicWrite('.tools/bun', new Uint8Array(binary), 0o755);
  await atomicWrite('.tools/compiler.json', JSON.stringify({ revision, archiveSha256: asset.digest, url: asset.browser_download_url }, null, 2) + '\n');
  console.log(`AOT compiler ready: ${revision}. Metadata: .tools/compiler.json`);
} finally { await rm(temp, { recursive: true, force: true }); }
