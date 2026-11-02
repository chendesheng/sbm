import { beforeAll, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
async function execute(argv: string[], env = process.env): Promise<string> {
  const child = Bun.spawn(argv, { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 240_000 });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`${argv.join(' ')} failed (${code}):\n${stdout}\n${stderr}`);
  return stdout;
}
async function compiledFixture(name: string): Promise<string> {
  const output = resolve(root, 'dist', `test-${name}`);
  await execute([process.execPath, 'scripts/build.mjs', `test/fixtures/${name}.ts`, output]);
  // Execute the compiled tests without Bun or Node.js available on PATH.
  return execute([output], { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
}

beforeAll(async () => { await execute([process.execPath, 'scripts/build.mjs']); }, 120_000);

test('compiled native CLI, subprocesses, private files, routes, locks, backup/restore and rollback', async () => {
  expect(await compiledFixture('native')).toContain('PASS: native CLI/self invocation');
}, 300_000);

test('compiled manager with real launchd, sing-box and loopback SOCKS traffic', async () => {
  expect(await compiledFixture('launchd')).toContain('PASS: official core, real launchd');
}, 300_000);
