import { existsSync, statSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const note = (message) => { try { writeSync(2, `${message}\n`); } catch { /* best-effort diagnostics */ } };

// Bun can skip ScriptC's postinstall on some platforms. The npm package then
// leaves a small shell stub at bin/scriptc.exe, so restore the native compiler
// from the platform package before invoking it.
export function scriptcCompiler() {
  if (process.env.SCRIPTC) return process.env.SCRIPTC;
  const compiler = resolve(root, 'node_modules/scriptc/bin/scriptc.exe');
  const native = existsSync(compiler) && statSync(compiler).size > 1_000_000;
  if (!native) {
    note('Preparing the ScriptC native compiler...');
    const installer = resolve(root, 'node_modules/scriptc/scripts/install-native.mjs');
    const install = spawnSync(process.execPath, [installer], { stdio: 'inherit' });
    if (install.error) { note(`Cannot prepare ScriptC: ${install.error.message}`); throw new Error(`Cannot prepare ScriptC: ${install.error.message}`); }
    if (install.status !== 0) { note(`ScriptC native installation exited ${install.status}.`); throw new Error('ScriptC native installation failed; reinstall with install scripts enabled.'); }
  }
  if (!existsSync(compiler)) { note('ScriptC native compiler is missing after installation.'); throw new Error('ScriptC native compiler is missing after installation.'); }
  const size = statSync(compiler).size;
  note(`Using ScriptC ${compiler} (${size} bytes)`);
  return compiler;
}
