#!/usr/bin/env bun
import { resolve } from 'node:path';
import { parseArgs, HELP } from './args';
import { Paths, run, exists, withLock } from './system';
import { Service, errorMessage } from './service';
import { install, releaseEndpoint, withPreparedInstall, activatePreparedInstall } from './install';
import { statusCacheRoot, cacheSize, formatCacheSize } from './cache';

async function elevate(argv: string[]): Promise<number> {
  const invocation = Bun.main.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, Bun.main];
  console.log('Requesting administrator privileges...');
  const child = Bun.spawn(['/usr/bin/sudo', '--', ...invocation, ...argv], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  // Keep the parent alive long enough to clean up the prepared download on Ctrl-C.
  const interrupt = () => { child.kill('SIGINT'); };
  const terminate = () => { child.kill('SIGTERM'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try { return await child.exited; }
  finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

async function main(): Promise<number> {
  const raw = process.argv.slice(2);
  if (raw[0] === '__install-prepared') {
    if (process.platform !== 'darwin' || process.getuid?.() !== 0 || raw.length !== 2) throw new Error('Prepared installation requires the privileged install handoff.');
    const paths = new Paths();
    await paths.prepare();
    await withLock(paths, async () => console.log(await activatePreparedInstall(new Service(paths, run), resolve(raw[1]))));
    return 0;
  }
  const args = parseArgs(raw);
  if (args.command === 'help') { console.log(HELP); return 0; }
  if (args.command === 'version') { console.log('0.1.0'); return 0; }
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('sbm supports macOS arm64 and x64 only.');
  if (args.command === 'install') releaseEndpoint(args.value);
  if (args.command === 'install' && process.getuid?.() !== 0) {
    return withPreparedInstall(args.value, directory => elevate(['__install-prepared', directory]));
  }
  if (args.command === 'start' && args.value) args.value = resolve(args.value);
  const paths = new Paths();
  // A missing core can be reported without elevation or creating managed files.
  if (args.command === 'start' && !await exists(paths.base)) throw new Error('sing-box is not installed. Run sbm install first.');
  if (process.getuid?.() !== 0 && !(args.command === 'status' && !await exists(paths.base))) {
    const argv: string[] = [args.command];
    if (args.value) argv.push(args.command === 'start' ? '--config' : '--version', args.value);
    return elevate(argv);
  }
  const service = new Service(paths, run);
  if (args.command === 'status') {
    const present = await exists(paths.base);
    const state = present ? await service.state() : { loaded: false, state: 'paused', pid: undefined };
    const installed = present && await exists(paths.core);
    const configuredLog = present ? await service.configuredLogPath() : undefined;
    const cache = await statusCacheRoot();
    let size: string;
    try { size = formatCacheSize(await cacheSize(cache)); }
    catch { size = 'unavailable'; }
    console.log([
      `Core: ${installed ? await service.version() : 'not installed'}`,
      `State: ${state.pid ? 'running' : state.loaded ? state.state : 'paused'}${state.pid ? ` (PID ${state.pid})` : ''}`,
      `Boot startup: ${await exists(paths.bootPlist) ? 'enabled' : 'disabled'}`,
      `Config: ${paths.config}${present && await exists(paths.config) ? '' : ' (not saved)'}`,
      `Stdout log: ${paths.stdout}`, `Stderr log: ${paths.stderr}`,
      ...(configuredLog ? [`Configured core log: ${configuredLog}`] : []),
      `Cache folder: ${cache}`, `Cache size: ${size}`,
    ].join('\n'));
    return 0;
  }
  await paths.prepare();
  await withLock(paths, async () => {
    switch (args.command) {
      case 'install': console.log(await install(service, args.value)); break;
      case 'start': console.log(await service.start(args.value)); break;
      case 'pause': await service.pause(); console.log('sing-box paused. Boot setting preserved.'); break;
      case 'enable': await service.enable(); console.log('Boot startup enabled. Current running state unchanged.'); break;
      case 'disable': await service.disable(); console.log('Boot startup disabled. Current running state unchanged.'); break;
    }
  });
  return 0;
}
if (import.meta.main) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`sbm: ${errorMessage(error)}`); process.exitCode = 1; }
}
