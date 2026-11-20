import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');

// Bun can skip ScriptC's postinstall on some platforms. The npm package then
// leaves a small shell stub at bin/scriptc.exe, so restore the native compiler
// from the platform package before invoking it.
export function scriptcCompiler() {
  if (process.env.SCRIPTC) return process.env.SCRIPTC;
  const compiler = resolve(root, 'node_modules/scriptc/bin/scriptc.exe');
  const native = existsSync(compiler) && statSync(compiler).size > 1_000_000;
  if (!native) {
    console.log('Preparing the ScriptC native compiler...');
    const installer = resolve(root, 'node_modules/scriptc/scripts/install-native.mjs');
    const install = spawnSync(process.execPath, [installer], { stdio: 'inherit' });
    if (install.error) throw new Error(`Cannot prepare ScriptC: ${install.error.message}`);
    if (install.status !== 0) throw new Error('ScriptC native installation failed; reinstall with install scripts enabled.');
  }
  if (!existsSync(compiler)) throw new Error('ScriptC native compiler is missing after installation.');
  return compiler;
}
