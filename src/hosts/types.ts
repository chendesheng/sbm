export type ServiceState = { loaded: boolean; pid?: number; state: string };

// start() makes the core run now; stop() stops it without touching the
// boot/sign-in registration. enableBoot()/disableBoot() change only that
// registration and never the current running state.
export interface ServiceHost {
  state(): Promise<ServiceState>;
  start(): Promise<void>;
  stop(): Promise<void>;
  bootEnabled(): Promise<boolean>;
  enableBoot(): Promise<void>;
  disableBoot(): Promise<void>;
}
