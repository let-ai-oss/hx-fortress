export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[]): CommandResult;
}

export interface ServiceState {
  loaded: boolean;
  pid: number | null;
}

export interface ServiceInstallOptions {
  executablePath: string;
  serviceLogPath: string;
}

export interface ServiceManager {
  readonly name: string;
  install(options: ServiceInstallOptions): Promise<void>;
  stop(): Promise<{ wasRunning: boolean }>;
  state(): Promise<ServiceState>;
}
