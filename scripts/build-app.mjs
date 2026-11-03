import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('sbm.app requires macOS.');
const root = resolve(import.meta.dirname, '..');
const build = join(root, 'dist/app-build');
const bundle = join(root, 'dist/sbm.app');
const macos = join(bundle, 'Contents/MacOS');
mkdirSync(build, { recursive: true }); mkdirSync(macos, { recursive: true });
const env = { ...process.env, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}` };
function execute(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const object = join(build, 'menubar.o');
execute('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-mmacosx-version-min=14.0', '-O2', '-c', 'native/menubar.m', '-o', object]);
const functions = [
  { name: 'nativeRun', symbol: 'sbm_run', params: ['bool'], returns: 'i32' },
  { name: 'nativeRender', symbol: 'sbm_render', params: ['i32', 'string', 'bool', 'bool', 'bool', 'bool', 'string'], returns: 'void' },
  { name: 'nativeAction', symbol: 'sbm_action', params: [], returns: 'i32' },
  { name: 'nativeAuthorize', symbol: 'sbm_authorize', params: ['i32', 'string'], returns: 'void' },
  { name: 'nativeAuthorizationResult', symbol: 'sbm_authorization_result', params: [
    { callback: { id: 'result', params: ['i32', 'string', { context: 'result' }], returns: 'void', lifetime: 'call' } }, { context: 'result' },
  ], returns: 'void' },
  { name: 'nativeAlert', symbol: 'sbm_alert', params: ['string', 'bool'], returns: 'void' },
  { name: 'nativeClosing', symbol: 'sbm_closing', params: [], returns: 'bool' },
  { name: 'nativeMainThread', symbol: 'sbm_main_thread', params: [], returns: 'bool' },
];
const manifest = join(build, 'ffi.json');
writeFileSync(manifest, JSON.stringify({ ffi_format: 7, libraries: [object], frameworks: ['AppKit', 'Foundation'], functions }));
const compiler = process.env.SCRIPTC || join(root, 'node_modules/.bin/scriptc');
execute(compiler, ['build', 'src/app/main.ts', '--ffi', manifest, '--strip', '--no-keep-llvm', '-o', join(macos, 'sbm')]);
execute(process.execPath, ['scripts/build.mjs', 'src/app/control.ts', join(macos, 'sbm-control')]);
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
writeFileSync(join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.chendesheng.sbm.app</string>
<key>CFBundleExecutable</key><string>sbm</string>
<key>CFBundleName</key><string>sbm</string>
<key>CFBundleDisplayName</key><string>sbm</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
execute('/usr/bin/codesign', ['--force', '--sign', '-', join(macos, 'sbm-control')]);
execute('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
console.log(bundle);
