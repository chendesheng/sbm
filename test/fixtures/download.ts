import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { download } from '../../src/download';
import { fetchRelease, withPreparedInstall } from '../../src/install';
import { run } from '../../src/system';

const base = await mkdtemp(join(tmpdir(), 'sbm-native-download-'));
const server = createServer(async (_request, response) => {
  response.writeHead(200, { 'content-length': '65536' });
  for (let i = 0; i < 8; i++) { response.write(Buffer.alloc(8192, i)); await sleep(40); }
  response.end();
});
await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No download test address.');
const local = `http://127.0.0.1:${address.port}/core`;
let partial = false, finished = false;
try {
  const output = join(base, 'download');
  await download('https://example.invalid/core', output, {
    request: async (_url, options) => fetch(local, options),
    onProgress: progress => {
      if (progress.receivedBytes > 0 && progress.receivedBytes < 65536) partial = true;
      if (progress.receivedBytes === 65536 && progress.totalBytes === 65536) finished = true;
    },
  });
  const bytes = await readFile(output);
  if (!partial || !finished || bytes.length !== 65536 || bytes[8192] !== 1 || bytes[65535] !== 7) throw new Error('Native streaming progress or binary writes failed.');
  if (((await stat(output)).mode & 0o777) !== 0o600) throw new Error('Native download permissions changed.');
  console.log('PASS: native fetch streaming, real incremental progress and binary file writes without curl.');
  let officialBytes = 0;
  // Force a private, fresh cache to exercise real HTTPS release redirects and
  // checksum/version verification; never activate or replace an installed core.
  await withPreparedInstall(undefined, async () => {}, fetchRelease, process.arch, download, run, join(base, 'official-cache'), {
    onProgress: progress => { officialBytes = progress.receivedBytes; },
  });
  if (!officialBytes) throw new Error('Official core download did not stream any bytes.');
  console.log('PASS: official HTTPS core download, redirects, checksum and executable version without activation.');
} finally { server.close(); await rm(base, { recursive: true, force: true }); }
