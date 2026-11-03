import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { download, type DownloadProgress, type DownloadOptions } from '../src/download';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function target() { const folder = await mkdtemp(join(tmpdir(), 'sbm-download-')); folders.push(folder); return join(folder, 'archive'); }
const url = 'https://example.invalid/core.tar.gz';
function response(length?: number) {
  const chunks = [new Uint8Array([0, 255]), new Uint8Array([128, 42])];
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); } }), { headers: length === undefined ? {} : { 'content-length': String(length) } });
}

test('streams binary bytes, reports actual progress, and creates a private exclusive file', async () => {
  const path = await target(), progress: DownloadProgress[] = [];
  await download(url, path, { request: async () => response(4), onProgress: event => progress.push(event) });
  expect((await readFile(path)).toString('hex')).toBe('00ff802a');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(progress[0]).toEqual({ receivedBytes: 0, totalBytes: 4 });
  expect(progress.some(event => event.receivedBytes > 0 && event.receivedBytes < 4)).toBe(true);
  expect(progress.at(-1)).toEqual({ receivedBytes: 4, totalBytes: 4 });
  await expect(download(url, path, { request: async () => response(4) })).rejects.toThrow();
  expect((await readFile(path)).toString('hex')).toBe('00ff802a');
});
test('supports byte progress when Content-Length is absent', async () => {
  const progress: DownloadProgress[] = [];
  await download(url, await target(), { request: async () => response(), onProgress: event => progress.push(event) });
  expect(progress.at(-1)).toEqual({ receivedBytes: 4, totalBytes: undefined });
});
test('follows HTTPS redirects and rejects downgrade redirects without leaving a partial file', async () => {
  const seen: string[] = [], path = await target();
  const request: NonNullable<DownloadOptions['request']> = async address => {
    seen.push(address);
    return seen.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.invalid/core' } }) : response(4);
  };
  await download(url, path, { request });
  expect(seen).toEqual([url, 'https://cdn.example.invalid/core']);
  await rm(path);
  await expect(download(url, path, { request: async () => new Response(null, { status: 302, headers: { location: 'http://example.invalid/core' } }) })).rejects.toThrow('HTTPS');
  expect(await Bun.file(path).exists()).toBe(false);
});
test('HTTP errors and size mismatches remove partial downloads', async () => {
  for (const request of [async () => new Response('failed', { status: 503 }), async () => response(9)]) {
    const path = await target();
    await expect(download(url, path, { request })).rejects.toThrow();
    expect(await Bun.file(path).exists()).toBe(false);
  }
});
test('cancellation cleans up and an existing destination is never removed', async () => {
  const path = await target(), controller = new AbortController();
  await expect(download(url, path, { request: async () => response(4), signal: controller.signal, onProgress: event => { if (event.receivedBytes) controller.abort(); } })).rejects.toThrow();
  expect(await Bun.file(path).exists()).toBe(false);
  await writeFile(path, 'existing');
  await expect(download(url, path, { signal: controller.signal })).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('existing');
});
