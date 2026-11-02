export const HELP = `sbm 0.1.0 — macOS sing-box manager

Usage:
  sbm install [--version <version>]  Install the latest stable or selected core
  sbm upgrade [--version <version>]  Alias of install
  sbm start [--config <file>]        Start; optionally apply a configuration
  sbm pause                        Pause until start or the next enabled boot
  sbm status                       Show state, version, config and log paths
  sbm enable                       Enable boot startup; do not start now
  sbm disable                      Disable boot startup; do not pause now
  sbm --help
  sbm --version

start never installs a core. Run sbm install first.
`;
export type Command = 'install' | 'start' | 'pause' | 'status' | 'enable' | 'disable' | 'help' | 'version';
export type Args = { command: Command; value?: string };
export function parseArgs(args: string[]): Args {
  if (!args.length || args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) return { command: 'help' };
  if (args.length === 1 && args[0] === '--version') return { command: 'version' };
  const name = args[0];
  const command = name === 'upgrade' ? 'install' : name;
  if (!['install', 'start', 'pause', 'status', 'enable', 'disable'].includes(command)) throw new Error(`Unknown command: ${name}. Run sbm --help.`);
  if (args.length === 2 && ['--help', '-h'].includes(args[1])) return { command: 'help' };
  const option = command === 'install' ? '--version' : command === 'start' ? '--config' : undefined;
  if (args.length !== 1 && !(option && args.length === 3 && args[1] === option && args[2] && !args[2].startsWith('--'))) throw new Error(`Invalid arguments for ${name}. Run sbm --help.`);
  return { command: command as Command, value: args[2] };
}
