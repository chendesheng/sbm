import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { join } from 'node:path';
import { atomicWrite, type Paths } from './system';
import type { RouteArgs } from './args';

type Field = 'ip_cidr' | 'domain' | 'domain_suffix';
type RuleSet = { version: number; rules: Array<Partial<Record<Field, string[]>>> };
export const routeFile = (paths: Paths, priority: boolean) => join(paths.base, priority ? 'direct-priority.json' : 'direct.json');

export function normalize(field: Field, input: string): string {
  if (field === 'ip_cidr') {
    const parts = input.split('/');
    const family = isIP(parts[0]);
    if (!family || parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) throw new Error('Invalid IP address or CIDR.');
    const bits = parts.length === 2 ? Number(parts[1]) : family === 4 ? 32 : 128;
    if (bits > (family === 4 ? 32 : 128)) throw new Error('Invalid CIDR prefix length.');
    const address = family === 6 ? new URL(`http://[${parts[0]}]/`).hostname.slice(1, -1) : parts[0];
    return `${address}/${bits}`;
  }
  const name = domainToASCII(input.toLowerCase());
  if (!name || name.length > 253 || name.endsWith('.') || name.split('.').some(x => !x || x.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x))) throw new Error('Invalid domain name.');
  return name;
}

async function load(path: string): Promise<RuleSet> {
  let data: unknown;
  try { data = JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Route list not initialized: ${path}. Apply a configuration with managed route lists first.`); throw e; }
  const obj = data as RuleSet;
  if (!obj || obj.version !== 1 || !Array.isArray(obj.rules) || obj.rules.length > 1 || Object.keys(obj).some(k => !['version', 'rules'].includes(k))) throw new Error(`Invalid managed rule set: ${path}`);
  for (const rule of obj.rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`Invalid managed rule set: ${path}`);
    for (const [key, values] of Object.entries(rule)) {
      if (!['ip_cidr', 'domain', 'domain_suffix'].includes(key) || !Array.isArray(values) || values.some(v => typeof v !== 'string' || normalize(key as Field, v) !== v)) throw new Error(`Invalid managed rule set: ${path}`);
    }
  }
  return obj;
}

export async function manageRoute(paths: Paths, args: RouteArgs): Promise<string> {
  const path = routeFile(paths, args.priority);
  const set = await load(path);
  if (args.action === 'list') {
    const rule = set.rules[0] || {};
    const rows = (['ip_cidr', 'domain', 'domain_suffix'] as const).flatMap(field => (rule[field] || []).map(value => `${field === 'ip_cidr' ? '--ip' : `--${field}`} ${value} --outbound direct`));
    return rows.length ? rows.join('\n') : 'No routes in this list.';
  }
  if (!args.field || !args.value || args.outbound !== 'direct') throw new Error('Invalid route arguments.');
  const value = normalize(args.field, args.value);
  const rule = set.rules[0] || {};
  const entries = rule[args.field] || [];
  const index = entries.indexOf(value);
  if (args.action === 'add' && index !== -1) return 'Route already exists; no change.';
  if (args.action === 'remove' && index === -1) throw new Error('Route not found; no change.');
  if (args.action === 'add') entries.push(value); else entries.splice(index, 1);
  if (entries.length) rule[args.field] = entries;
  else if (args.field === 'ip_cidr') delete rule.ip_cidr;
  else if (args.field === 'domain') delete rule.domain;
  else delete rule.domain_suffix;
  set.rules = Object.keys(rule).length ? [rule] : [];
  await atomicWrite(path, JSON.stringify(set, null, 2) + '\n');
  return `Route ${args.action === 'add' ? 'added' : 'removed'}.`;
}
