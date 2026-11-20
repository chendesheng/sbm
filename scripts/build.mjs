import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scriptcCompiler } from './scriptc.mjs';

const entry = process.argv[2] || 'src/cli.ts';
const output = process.argv[3] || 'dist/sbm';
if (process.argv.length > 4) throw new Error('Usage: bun scripts/build.mjs [entry.ts] [output]');
const env = { ...process.env };
// Use the active Xcode SDK/linker rather than an unrelated Clang on PATH.
if (process.platform === 'darwin') {
  const clang = spawnSync('/usr/bin/xcrun', ['--find', 'clang'], { encoding: 'utf8' });
  if (clang.status !== 0) throw new Error('Install the Xcode Command Line Tools before building.');
  env.PATH = `/usr/bin:/bin:/usr/sbin:/sbin:${env.PATH || ''}`;
}
mkdirSync(dirname(output), { recursive: true });
const compiler = scriptcCompiler();
const build = spawnSync(compiler, ['build', entry, '--strip', '--no-keep-llvm', '-o', output], { env, stdio: 'inherit' });
if (build.error) throw new Error(`Cannot run ScriptC at ${compiler}: ${build.error.message}. Install scriptc 0.4.7 or set SCRIPTC to its executable.`);
if (build.status !== 0) process.exit(build.status ?? 1);
