import { open, rm } from 'node:fs/promises';

export type DownloadProgress = { receivedBytes: number; totalBytes?: number };
export type DownloadOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  request?: (url: string, options: RequestInit) => Promise<Response>;
};
export type Downloader = (url: string, destination: string, options?: DownloadOptions) => Promise<void>;

function https(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Downloads and redirects must use HTTPS.');
  return parsed.href;
}

// Stream bytes into an exclusive private file; never promote a partial download.
export const download: Downloader = async (url, destination, options = {}) => {
  let current = https(url);
  const file = await open(destination, 'wx', 0o600);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort);
  const deadline = setTimeout(() => controller.abort(new Error('Download timed out.')), 120_000);
  let complete = false;
  try {
    if (controller.signal.aborted) throw new Error('Download cancelled.');
    const request = options.request || fetch;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 10; redirects++) {
      const connecting = setTimeout(() => controller.abort(new Error('Download connection timed out.')), 20_000);
      try {
        response = await request(current, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'sbm/0.1.1', 'Accept-Encoding': 'identity' } });
      } finally { clearTimeout(connecting); }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 10) throw new Error('Invalid or excessive download redirects.');
      current = https(new URL(location, current).href);
    }
    if (!response || !response.ok) throw new Error(`Download failed: HTTP ${response?.status ?? 0}.`);
    if (!response.body) throw new Error('Download returned no response body.');
    const length = response.headers.get('content-length');
    const total = length && /^\d+$/.test(length) && !response.headers.get('content-encoding') ? Number(length) : undefined;
    let received = 0, reported = 0;
    options.onProgress?.({ receivedBytes: 0, totalBytes: total });
    const reader = response.body.getReader();
    try {
      for (;;) {
        if (controller.signal.aborted) throw new Error('Download cancelled.');
        const chunk = await reader.read();
        if (chunk.done) break;
        const bytes = chunk.value as Uint8Array;
        await file.writeFile(bytes);
        received += bytes.byteLength;
        if (Date.now() - reported >= 100) {
          options.onProgress?.({ receivedBytes: received, totalBytes: total });
          reported = Date.now();
        }
      }
    } finally { reader.releaseLock(); }
    if (controller.signal.aborted) throw new Error('Download cancelled.');
    if (total !== undefined && received !== total) throw new Error('Download size does not match Content-Length.');
    options.onProgress?.({ receivedBytes: received, totalBytes: total });
    complete = true;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    try { await file.close(); }
    finally { if (!complete) await rm(destination, { force: true }); }
  }
};
