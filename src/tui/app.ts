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
}

export interface TuiApp {
  state: () => TuiAppState;
  moveRow: (delta: number) => void;
  moveAction: (delta: number) => void;
  activate: () => Promise<void>;
}

export function createTuiApp(params: CreateTuiAppParams): TuiApp {
  const currentState: TuiAppState = {
    screen: "main",
    selectedRow: 0,
    selectedAction: 0,
    pendingDetailsFor: null,
    error: null,
  };

  return {
    state: () => ({ ...currentState }),
    moveRow: (delta) => {
      currentState.selectedRow = wrapIndex(
        currentState.selectedRow + delta,
        params.model.rows.length,
      );
      currentState.selectedAction = 0;
    },
    moveAction: (delta) => {
      currentState.selectedAction = wrapIndex(
        currentState.selectedAction + delta,
        currentRow(params.model, currentState.selectedRow).actions.length,
      );
    },
    activate: async () => {
      const action =
        currentRow(params.model, currentState.selectedRow).actions[
          currentState.selectedAction
        ];

      currentState.error = null;

      try {
        switch (action.kind) {
          case "start":
            await params.actions.start();
            currentState.pendingDetailsFor = null;
            currentState.screen = "main";
            return;
          case "stop":
            await params.actions.stop();
            currentState.pendingDetailsFor = null;
            currentState.screen = "main";
            return;
          case "update":
            await params.actions.update(action.version);
            currentState.pendingDetailsFor = null;
            currentState.screen = "main";
            return;
          case "view-details":
            currentState.screen = "details";
            currentState.pendingDetailsFor = currentRow(
              params.model,
              currentState.selectedRow,
            ).id;
            return;
        }
      } catch (error) {
        currentState.error = errorMessage(error);
        throw error;
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
