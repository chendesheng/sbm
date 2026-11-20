import { Paths, type Runner } from '../system';
import { isWindows } from '../platform';
import type { ServiceHost } from './types';
import { LaunchdHost } from './launchd';
import { WindowsUserHost } from './windows';

export type { ServiceHost, ServiceState } from './types';
export { plist } from './launchd';
export { WindowsUserHost } from './windows';

export function createServiceHost(paths: Paths, runner: Runner): ServiceHost {
  return isWindows(paths.kind) ? new WindowsUserHost(paths, runner) : new LaunchdHost(paths, runner);
}
