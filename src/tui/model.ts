import type { BuildMainScreenModelParams, MainScreenAction, MainScreenModel, MainScreenRow, MainScreenRowId } from "./types";

const ROW_ORDER: MainScreenRowId[] = [
  "session_vault",
  "session_computer",
  "devops_utility",
];

const LABELS: Record<MainScreenRowId, string> = {
  session_vault: "session_vault",
  session_computer: "session_computer",
  devops_utility: "devops_utility",
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
      action(params.service.pid === null ? "start" : "stop"),
      ...(update ? [action("update")] : []),
      action("view-details"),
    ],
  };
}

function action(kind: MainScreenAction["kind"]): MainScreenAction {
  return {
    kind,
    enabled: true,
  };
}
