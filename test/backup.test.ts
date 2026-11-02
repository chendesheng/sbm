import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backupConfig, restoreConfig } from '../src/backup';
import { parseArgs } from '../src/args';
import { Service } from '../src/service';
import { Paths, type Runner } from '../src/system';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(running = false) {
  const root = await mkdtemp(join(tmpdir(), 'sbm-backup-')); dirs.push(root);
  const p = new Paths(join(root, 'managed'), join(root, 'boot')); await p.prepare();
  await mkdir(p.bootDir, { recursive: true });
  await writeFile(p.core, 'core');
  await writeFile(join(p.base, 'direct.json'), '{"version":1,"rules":[]}');
  const config = JSON.stringify({ route: { rule_set: [{ type: 'local', tag: 'direct', path: join(p.base, 'direct.json') }] }, marker: 'saved' });
  await writeFile(p.config, config); await writeFile(join(p.base, 'config.json.previous'), '{"previous":true}');
  let active = running, reject = false;
  const runner: Runner = async a => {
    if (a[0] === '/bin/launchctl') {
      if (a[1] === 'print') return active ? {code:0,stdout:'state = running\npid = 101\n',stderr:''} : {code:1,stdout:'',stderr:'Could not find service'};
      if (a[1] === 'bootout') active = false;
      if (a[1] === 'bootstrap') active = true;
      return {code:0,stdout:'',stderr:''};
    }
    if (a[1] === 'check') return reject ? {code:1,stdout:'',stderr:'invalid config'} : {code:0,stdout:'',stderr:''};
    throw new Error(`Unexpected command: ${a[0]}`);
  };
  return { p, root, config, service: new Service(p, runner, { attempts: 4, interval: 1, stableSamples: 1 }), get active() { return active; }, set reject(v: boolean) { reject = v; } };
}
test('backup and restore require --file', () => {
  expect(parseArgs(['config','backup','--file','save.zip'])).toEqual({command:'config',configAction:'backup',value:'save.zip'});
  expect(parseArgs(['config','restore','--file','save.zip']).configAction).toBe('restore');
  expect(() => parseArgs(['config','backup','save.zip'])).toThrow();
});
test('backs up managed files and restores them while keeping a paused service paused', async () => {
  const f = await fixture(); const zip = join(f.root, 'backup.zip');
  await writeFile(join(f.p.base,'cache.db'),'runtime cache');
  await backupConfig(f.p,zip);
  expect((await stat(zip)).mode & 0o777).toBe(0o600);
  await expect(backupConfig(f.p,zip)).rejects.toThrow();
  await writeFile(f.p.config,'{"changed":true}'); await writeFile(join(f.p.base,'direct.json'),'changed');
  await restoreConfig(f.service,zip);
  expect(await readFile(f.p.config,'utf8')).toBe(f.config);
  expect(await readFile(join(f.p.base,'direct.json'),'utf8')).toBe('{"version":1,"rules":[]}');
  expect(await readFile(join(f.p.base,'config.json.previous'),'utf8')).toBe('{"previous":true}');
  expect(await readFile(join(f.p.base,'cache.db'),'utf8')).toBe('runtime cache');
  expect(f.active).toBe(false);
});
test('restores and restarts a running service, including boot startup setting', async () => {
  const f = await fixture(true); const zip = join(f.root,'backup.zip');
  await writeFile(f.p.bootPlist,'enabled'); await backupConfig(f.p,zip);
  await rm(f.p.bootPlist); await writeFile(f.p.config,'{"changed":true}');
  await restoreConfig(f.service,zip);
  expect(f.active).toBe(true); expect(await readFile(f.p.config,'utf8')).toBe(f.config);
  expect(await readFile(f.p.bootPlist,'utf8')).toContain('<plist');
});
test('failed validation rolls back files and restores the running service', async () => {
  const f = await fixture(true); const zip = join(f.root,'backup.zip');
  await backupConfig(f.p,zip); await writeFile(f.p.config,'{"current":true}');
  await writeFile(join(f.p.base,'direct.json'),'current'); f.reject = true;
  await expect(restoreConfig(f.service,zip)).rejects.toThrow('Previous configuration and service state restored');
  expect(await readFile(f.p.config,'utf8')).toBe('{"current":true}');
  expect(await readFile(join(f.p.base,'direct.json'),'utf8')).toBe('current'); expect(f.active).toBe(true);
});
test('rejects external references and invalid archives before modifying service files', async () => {
  const f = await fixture(true); const zip = join(f.root,'bad.zip');
  await writeFile(f.p.config,JSON.stringify({route:{rule_set:[{type:'local',path:'/elsewhere/rules.json'}]}}));
  await expect(backupConfig(f.p,zip)).rejects.toThrow('outside the managed');
  await writeFile(zip,'not a zip'); await expect(restoreConfig(f.service,zip)).rejects.toThrow();
  expect(f.active).toBe(true);
});
