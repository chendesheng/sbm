import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs, HELP } from './args';
import { Paths, run, exists, selfInvocation } from './system';
import { Service, errorMessage } from './service';
import { install, releaseEndpoint, withPreparedInstall, activatePreparedInstall, activatePreparedAsUser } from './install';
import { managedStorage, migrateStorage, registerStorage, requireOwner, withDataLock, type Owner } from './storage';
import { statusText } from './status';
import { manageRoute } from './routes';
import { backupConfig, restoreConfig } from './backup';

async function elevate(argv: string[]): Promise<number> {
  const invocation = selfInvocation();
  console.log('Requesting administrator privileges...');
  const child = spawn('/usr/bin/sudo', ['--', ...invocation, ...argv], { stdio: 'inherit' });
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  });
  // Keep the parent alive long enough to clean up the prepared download on Ctrl-C.
  const interrupt = () => { child.kill('SIGINT'); };
  const terminate = () => { child.kill('SIGTERM'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try { return await exited; }
  finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

async function preparePrivileged(service: Service, owner: Owner, legacy: boolean) {
  if (legacy) await migrateStorage(service, owner);
  else {
    await service.paths.prepare();
    await registerStorage(service.paths, owner);
  }
}

async function main(): Promise<number> {
  const raw = process.argv.slice(2);
  if (raw[0] === '__migrate') {
    if (process.platform !== 'darwin' || process.getuid?.() !== 0 || raw.length !== 1) throw new Error('Storage migration requires administrator privileges.');
    const storage = await managedStorage();
    await migrateStorage(new Service(storage.paths, run), storage.owner);
    console.log(`Managed files moved to ${storage.paths.base}.`);
    return 0;
  }
  if (raw[0] === '__install-prepared') {
    if (process.platform !== 'darwin' || process.getuid?.() !== 0 || raw.length !== 2) throw new Error('Prepared installation requires the privileged install handoff.');
    const storage = await managedStorage();
    const service = new Service(storage.paths, run);
    await preparePrivileged(service, storage.owner, storage.legacy);
    await withDataLock(storage.paths, storage.owner, async () => console.log(await activatePreparedInstall(service, resolve(raw[1]))));
    return 0;
  }
  const args = parseArgs(raw);
  if (args.command === 'help') { console.log(HELP); return 0; }
  if (args.command === 'version') { console.log('0.1.0'); return 0; }
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('sbm supports macOS arm64 and x64 only.');
  if (args.command === 'install') releaseEndpoint(args.value);
  let storage = await managedStorage();
  let paths = storage.paths;
  let service = new Service(paths, run);
  if (args.command === 'status') {
    const readablePaths = storage.legacy ? new Paths(paths.systemBase) : paths;
    console.log(await statusText(new Service(readablePaths, run), storage.legacy));
    return 0;
  }
  requireOwner(storage.owner);
  if (storage.legacy && process.getuid?.() !== 0) {
    console.log('A one-time administrator authorization is needed to move sbm files into your user Library.');
    console.log('Migration pauses and restarts a running sing-box service and can disconnect remote sessions. Use local access or an independent connection.');
  }
  if (args.command === 'install' && process.getuid?.() !== 0) {
    return withPreparedInstall(args.value, async directory => {
      if (storage.legacy) return elevate(['__install-prepared', directory]);
      await paths.prepare();
      return activatePreparedAsUser(service, directory, storage.owner, () => elevate(['__install-prepared', directory]));
    });
  }
  if (storage.legacy && process.getuid?.() !== 0) {
    const code = await elevate(['__migrate']);
    if (code !== 0) return code;
    storage = await managedStorage(); paths = storage.paths; service = new Service(paths, run);
  }
  if (args.command === 'start' && args.value) { args.value = resolve(args.value); raw[2] = args.value; }
  if (args.command === 'config' && args.configAction && args.value) { args.value = resolve(args.value); raw[3] = args.value; }
  if (!storage.legacy) {
    if (args.command === 'start') {
      await service.requireCore();
      if (!args.value && (await service.state()).pid) { console.log('sing-box is already running.'); return 0; }
    }
    if (args.command === 'pause' && !(await service.state()).loaded) { console.log('sing-box paused. Boot setting preserved.'); return 0; }
    if (args.command === 'disable' && !await exists(paths.bootPlist)) { console.log('Boot startup disabled. Current running state unchanged.'); return 0; }
  }
  const protectedAction = ['start', 'pause', 'enable', 'disable'].includes(args.command) || args.command === 'config' && args.configAction === 'restore';
  if (protectedAction && process.getuid?.() !== 0) return elevate(raw);
  if (process.getuid?.() === 0) await preparePrivileged(service, storage.owner, storage.legacy);
  else if (!await exists(paths.base)) throw new Error('No saved configuration. Run sbm install and sbm start --config <file> first.');
  await withDataLock(paths, storage.owner, async () => {
    switch (args.command) {
      case 'install': console.log(await install(service, args.value)); break;
      case 'start': console.log(await service.start(args.value)); break;
      case 'pause': await service.pause(); console.log('sing-box paused. Boot setting preserved.'); break;
      case 'enable': await service.enable(); console.log('Boot startup enabled. Current running state unchanged.'); break;
      case 'disable': await service.disable(); console.log('Boot startup disabled. Current running state unchanged.'); break;
      case 'config':
        if (args.configAction === 'backup') console.log(await backupConfig(paths, args.value!));
        else if (args.configAction === 'restore') console.log(await restoreConfig(service, args.value!));
        else console.log(await manageRoute(paths, args.route!));
        break;
    }
  });
  return 0;
}
if (import.meta.main) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`sbm: ${errorMessage(error)}`); process.exitCode = 1; }
}
