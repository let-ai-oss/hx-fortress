import type { MainScreenModel, MainScreenRowId } from "./types";

export type TuiScreen = "main" | "details";

export interface TuiAppState {
  screen: TuiScreen;
  selectedRow: number;
  selectedAction: number;
  pendingDetailsFor: MainScreenRowId | null;
  error: string | null;
}

export interface TuiAppActions {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  update: (version: string) => Promise<void>;
}

export interface CreateTuiAppParams {
  model: MainScreenModel;
  actions: TuiAppActions;
  reloadModel?: () => Promise<MainScreenModel>;
}

export interface TuiApp {
  model: () => Readonly<MainScreenModel>;
  state: () => TuiAppState;
  moveRow: (delta: number) => void;
  moveAction: (delta: number) => void;
  activate: () => Promise<void>;
}

export function createTuiApp(params: CreateTuiAppParams): TuiApp {
  let currentModel = params.model;
  const currentState: TuiAppState = {
    screen: "main",
    selectedRow: 0,
    selectedAction: 0,
    pendingDetailsFor: null,
    error: null,
  };

  const returnToMain = () => {
    currentState.pendingDetailsFor = null;
    currentState.screen = "main";
  };

  const refreshModel = async () => {
    if (!params.reloadModel) return;
    await params.reloadModel()
      .then((m) => {
        currentModel = m;
        const newActions = currentRow(m, currentState.selectedRow).actions;
        if (currentState.selectedAction >= newActions.length) {
          currentState.selectedAction = 0;
        }
      })
      .catch(() => {});
  };

  return {
    model: () => currentModel,
    state: () => ({ ...currentState }),
    moveRow: (delta) => {
      const nextRow = wrapIndex(
        currentState.selectedRow + delta,
        currentModel.rows.length,
      );

      if (nextRow !== currentState.selectedRow) {
        currentState.selectedRow = nextRow;
        currentState.selectedAction = 0;
      }
    },
    moveAction: (delta) => {
      currentState.selectedAction = wrapIndex(
        currentState.selectedAction + delta,
        currentRow(currentModel, currentState.selectedRow).actions.length,
      );
    },
    activate: async () => {
      const action =
        currentRow(currentModel, currentState.selectedRow).actions[
          currentState.selectedAction
        ];

      currentState.error = null;

      if (!action.enabled) {
        return;
      }

      try {
        switch (action.kind) {
          case "start":
            await params.actions.start();
            returnToMain();
            await refreshModel();
            return;
          case "stop":
            await params.actions.stop();
            returnToMain();
            await refreshModel();
            return;
          case "update":
            await params.actions.update(action.version);
            returnToMain();
            await refreshModel();
            return;
          case "view-details":
            currentState.screen = "details";
            currentState.pendingDetailsFor = currentRow(
              currentModel,
              currentState.selectedRow,
            ).id;
            return;
        }
      } catch (error) {
        currentState.error = errorMessage(error);
        return;
      }
    },
  };
}

function currentRow(model: MainScreenModel, selectedRow: number) {
  return model.rows[selectedRow] ?? model.rows[0];
}

function wrapIndex(value: number, length: number): number {
  return ((value % length) + length) % length;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
