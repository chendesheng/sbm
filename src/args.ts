export const HELP = `sbm 0.1.0 — macOS sing-box manager

Usage:
  sbm install [--version <version>]  Install the latest stable or selected core
  sbm upgrade [--version <version>]  Alias of install
  sbm start [--config <file>]        Start; optionally apply a configuration
  sbm pause                        Pause until start or the next enabled boot
  sbm status                       Show state, version, config and log paths
  sbm enable                       Enable boot startup; do not start now
  sbm disable                      Disable boot startup; do not pause now
  sbm config route list [--priority]
  sbm config route add|remove --outbound direct (--ip <address>|--domain <name>|--domain_suffix <name>) [--priority]
  sbm --help
  sbm --version

start never installs a core. Run sbm install first.
`;
export type Command = 'install' | 'start' | 'pause' | 'status' | 'enable' | 'disable' | 'help' | 'version' | 'config';
export type RouteArgs = { action: 'list' | 'add' | 'remove'; priority: boolean; field?: 'ip_cidr' | 'domain' | 'domain_suffix'; value?: string; outbound?: string };
export type Args = { command: Command; value?: string; route?: RouteArgs };
export function parseArgs(args: string[]): Args {
  if (!args.length || args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) return { command: 'help' };
  if (args.length === 1 && args[0] === '--version') return { command: 'version' };
  if (args[0] === 'config') {
    if (args.length === 2 && ['--help', '-h'].includes(args[1])) return { command: 'help' };
    const action = args[2];
    if (args[1] !== 'route' || !['list', 'add', 'remove'].includes(action)) throw new Error('Invalid config route command. Run sbm --help.');
    const route: RouteArgs = { action: action as RouteArgs['action'], priority: false };
    for (let i = 3; i < args.length; i++) {
      const option = args[i];
      if (option === '--priority') { if (route.priority) throw new Error('Duplicate --priority.'); route.priority = true; continue; }
      if (!['--ip', '--domain', '--domain_suffix', '--outbound'].includes(option) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid route option: ${option}`);
      const value = args[++i];
      if (option === '--outbound') { if (route.outbound) throw new Error('Duplicate --outbound.'); route.outbound = value; }
      else { if (route.field) throw new Error('Specify exactly one match option.'); route.field = option === '--ip' ? 'ip_cidr' : option.slice(2) as RouteArgs['field']; route.value = value; }
    }
    if (action === 'list' ? !!route.field || !!route.outbound : !route.field || !route.outbound) throw new Error('Invalid route arguments. Run sbm --help.');
    if (route.outbound && route.outbound !== 'direct') throw new Error('Only the direct outbound is supported.');
    return { command: 'config', route };
  }
  const name = args[0];
  const command = name === 'upgrade' ? 'install' : name;
  if (!['install', 'start', 'pause', 'status', 'enable', 'disable'].includes(command)) throw new Error(`Unknown command: ${name}. Run sbm --help.`);
  if (args.length === 2 && ['--help', '-h'].includes(args[1])) return { command: 'help' };
  const option = command === 'install' ? '--version' : command === 'start' ? '--config' : undefined;
  if (args.length !== 1 && !(option && args.length === 3 && args[1] === option && args[2] && !args[2].startsWith('--'))) throw new Error(`Invalid arguments for ${name}. Run sbm --help.`);
  return { command: command as Command, value: args[2] };
}
