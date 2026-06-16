import type {
  BuildDetailsScreenModelParams,
  BuildMainScreenModelParams,
  DetailsScreenAction,
  DetailsScreenModel,
  MainScreenAction,
  MainScreenModel,
  MainScreenRow,
  MainScreenRowId,
} from "./types";


const ROW_ORDER: MainScreenRowId[] = [
  "session_vault",
  "session_computer",
  "devops_utility",
];

const LABELS: Record<MainScreenRowId, string> = {
  session_vault: "session_vault",
  session_computer: "session_computer",
  devops_utility: "devops-utility",
};

const FOOTER_NOTE =
  "Safe to exit HX Fortress. Components keep running in the background.";

export function buildMainScreenModel(
  params: BuildMainScreenModelParams,
): MainScreenModel {
  return {
    rows: ROW_ORDER.map((id) => buildRow(id, params)),
    footerNote: FOOTER_NOTE,
  };
}

function buildRow(
  id: MainScreenRowId,
  params: BuildMainScreenModelParams,
): MainScreenRow {
  if (id !== "session_vault") {
    return {
      id,
      label: LABELS[id],
      availability: "unavailable",
      statusLabel: "unavailable",
      installedVersion: null,
      availableVersion: null,
      actions: [action("view-details")],
    };
  }

  const runtimeStatus = params.snapshot?.modules.find((module) => module.id === id);
  const installed = params.installedModules.find((module) => module.moduleId === id);
  const update = params.updates[id];
  const hasRunningService = params.service.loaded && params.service.pid !== null;
  const hasFreshSnapshot =
    hasRunningService &&
    params.snapshot !== null &&
    params.snapshot.host.pid === params.service.pid;

  return {
    id,
    label: LABELS[id],
    availability: "live",
    statusLabel: hasFreshSnapshot ? runtimeStatus?.state ?? "stopped" : "stopped",
    installedVersion: installed?.version ?? null,
    availableVersion: update?.version ?? null,
    actions: [
      action(!hasRunningService ? "start" : "stop"),
      ...(update ? [updateAction(update.version)] : []),
      action("view-details"),
    ],
  };
}

function action(kind: Exclude<MainScreenAction["kind"], "update">): MainScreenAction {
  return {
    kind,
    enabled: true,
  };
}

function updateAction(version: string): MainScreenAction {
  return {
    kind: "update",
    enabled: true,
    version,
  };
}

const BUNDLED_CORE_MODULES: ReadonlySet<MainScreenRowId> = new Set(["session_vault"]);

export function buildDetailsScreenModel(params: BuildDetailsScreenModelParams): DetailsScreenModel {
  const { id, installedVersion, availableVersion } = params;
  const isBundledCore = BUNDLED_CORE_MODULES.has(id);

  if (installedVersion === null && !isBundledCore) {
    return {
      id,
      label: LABELS[id],
      installedVersion: null,
      availableVersion: null,
      isBundledCore: false,
      actions: [{ kind: "back", enabled: true }],
    };
  }

  const actions: DetailsScreenAction[] = [];
  if (availableVersion !== null) {
    actions.push({ kind: "update", enabled: true, version: availableVersion });
  }
  actions.push({
    kind: "uninstall",
    enabled: !isBundledCore,
    reason: isBundledCore ? "bundled component — cannot remove" : null,
  });
  actions.push({ kind: "back", enabled: true });

  return {
    id,
    label: LABELS[id],
    installedVersion,
    availableVersion,
    isBundledCore,
    actions,
  };
}
