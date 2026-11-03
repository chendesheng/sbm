import { resolve } from 'node:path';
import { Service, errorMessage } from '../service';
import { managedStorage, readRegistration, withDataLock } from '../storage';
import { activatePreparedInstall } from '../install';
import { run } from '../system';

async function main() {
  if (process.platform !== 'darwin' || process.getuid?.() !== 0) throw new Error('This app worker requires administrator authorization.');
  const args = process.argv.slice(2);
  const action = args[0];
  if (!['start', 'pause', 'upgrade'].includes(action) || args.length !== (action === 'upgrade' ? 2 : 1)) throw new Error('Invalid app worker action.');
  if (!await readRegistration()) throw new Error('Set up the sbm service with the CLI first.');
  const storage = await managedStorage();
  const service = new Service(storage.paths, run);
  await withDataLock(storage.paths, storage.owner, async () => {
    await storage.paths.prepare();
    if (action === 'start') console.log(await service.start());
    else if (action === 'pause') await service.pause();
    else console.log(await activatePreparedInstall(service, resolve(args[1])));
  });
}
try { await main(); }
catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
