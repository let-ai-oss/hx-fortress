import { homedir, platform, userInfo } from "node:os";

import { LaunchdServiceManager } from "./launchd";
import { SystemdServiceManager } from "./systemd";
import type { ServiceInstallOptions, ServiceManager, ServiceState } from "./types";

export type {
  CommandResult,
  CommandRunner,
  ServiceInstallOptions,
  ServiceManager,
  ServiceState,
} from "./types";

interface ServiceManagerOptions {
  platform?: string;
  home?: string;
  uid?: number;
}

export function getServiceManager(
  options: ServiceManagerOptions = {},
): ServiceManager {
  const currentPlatform = options.platform ?? platform();
  const home = options.home ?? homedir();
  const uid = options.uid ?? userInfo().uid;

  if (currentPlatform === "darwin") {
    return new LaunchdServiceManager({ home, uid });
  }
  if (currentPlatform === "linux") {
    return new SystemdServiceManager({ home });
  }
  return new UnsupportedServiceManager(currentPlatform);
}

class UnsupportedServiceManager implements ServiceManager {
  readonly name = "unsupported";

  constructor(private readonly currentPlatform: string) {}

  install(options: ServiceInstallOptions): Promise<void> {
    void options;
    return Promise.reject(this.error());
  }

  stop(): Promise<{ wasRunning: boolean }> {
    return Promise.reject(this.error());
  }

  state(): Promise<ServiceState> {
    return Promise.reject(this.error());
  }

  private error(): Error {
    return new Error(
      `Fortress background service is not supported on ${this.currentPlatform}.`,
    );
  }
}
