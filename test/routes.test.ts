import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/args';
import { manageRoute, normalize, routeFile } from '../src/routes';
import { Paths, withLock } from '../src/system';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function fixture() {
  const d = await mkdtemp(join(tmpdir(), 'sbm-routes-')); dirs.push(d);
  const paths = new Paths(d); await paths.prepare();
  for (const priority of [false, true]) await writeFile(routeFile(paths, priority), '{"version":1,"rules":[]}', { mode: 0o600 });
  return paths;
}
test('parses route flags in either order and rejects ambiguous inputs', () => {
  expect(parseArgs(['config','route','add','--domain_suffix','example.com','--outbound','direct','--priority']).route).toEqual({ action:'add', priority:true, field:'domain_suffix', value:'example.com', outbound:'direct' });
  for (const args of [
    ['config','route','add','--ip','1.2.3.4'], ['config','route','add','--ip','1.2.3.4','--domain','a.test','--outbound','direct'],
    ['config','route','list','--outbound','direct'], ['config','route','add','--ip','1.2.3.4','--outbound','proxy'],
  ]) expect(() => parseArgs(args)).toThrow();
});
test('validates and normalizes addresses and domain types', () => {
  expect(normalize('ip_cidr','192.0.2.1')).toBe('192.0.2.1/32');
  expect(normalize('ip_cidr','2001:DB8::1')).toBe('2001:db8::1/128');
  expect(normalize('domain','EXAMPLE.com')).toBe('example.com');
  for (const [field, value] of [['ip_cidr','1.2.3.4/33'],['ip_cidr','bad'],['domain','https://example.com'],['domain_suffix','*.example.com']] as const) expect(() => normalize(field,value)).toThrow();
});
test('adds, lists and removes separate exact, suffix and priority routes', async () => {
  const p = await fixture();
  const command = (args: string[]) => manageRoute(p, parseArgs(['config','route',...args]).route!);
  await command(['add','--domain','Example.com','--outbound','direct']);
  await command(['add','--domain_suffix','example.com','--outbound','direct']);
  await command(['add','--ip','192.0.2.1','--outbound','direct','--priority']);
  expect(await command(['list'])).toContain('--domain_suffix example.com');
  expect(await command(['list'])).not.toContain('192.0.2.1');
  expect(await command(['list','--priority'])).toContain('192.0.2.1/32');
  expect(await command(['add','--domain','example.com','--outbound','direct'])).toContain('already exists');
  await command(['remove','--domain','example.com','--outbound','direct']);
  await expect(command(['remove','--domain','example.com','--outbound','direct'])).rejects.toThrow('not found');
  expect((await stat(routeFile(p,false))).mode & 0o777).toBe(0o600);
});
test('serializes competing changes and refuses unsupported existing data', async () => {
  const p = await fixture();
  await Promise.all(['192.0.2.1','192.0.2.2'].map(value => withLock(p, () => manageRoute(p,{action:'add',priority:false,field:'ip_cidr',value,outbound:'direct'}))));
  expect(JSON.parse(await readFile(routeFile(p,false),'utf8')).rules[0].ip_cidr).toHaveLength(2);
  await writeFile(routeFile(p,false),'{"version":1,"rules":[{"domain_keyword":["x"]}]}');
  await expect(manageRoute(p,{action:'list',priority:false})).rejects.toThrow('Invalid managed rule set');
});
