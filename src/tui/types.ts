import type { InstalledModuleRecord } from "../host/module-inventory";
import type { HostStatusSnapshot, ModuleState } from "../host/types";
import type { ServiceState } from "../service/types";

export type MainScreenRowId =
  | "session_vault"
  | "session_computer"
  | "devops_utility";

export type MainScreenAvailability = "live" | "unavailable";

export type MainScreenActionKind =
  | "start"
  | "stop"
  | "update"
  | "view-details";

export interface MainScreenAction {
  kind: MainScreenActionKind;
  enabled: boolean;
}

export interface MainScreenRow {
  id: MainScreenRowId;
  label: string;
  availability: MainScreenAvailability;
  statusLabel: ModuleState | "unavailable";
  installedVersion: string | null;
  availableVersion: string | null;
  actions: MainScreenAction[];
}

export interface MainScreenModel {
  rows: MainScreenRow[];
  footerNote: string;
}

export interface ModuleUpdateStatus {
  kind: "module";
  version: string;
}

export type ModuleUpdateMap = Partial<Record<MainScreenRowId, ModuleUpdateStatus>>;

export interface BuildMainScreenModelParams {
  service: ServiceState;
  snapshot: HostStatusSnapshot | null;
  installedModules: InstalledModuleRecord[];
  updates: ModuleUpdateMap;
}
