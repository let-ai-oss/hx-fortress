import type { TuiApp } from "./app";
import type { MainScreenAction, MainScreenRow } from "./types";

const CSI = "\u001b[";
const CLEAR_SCREEN = `${CSI}2J${CSI}H`;
const CLEAR_REMAINDER = `${CSI}J`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const RESET = `${CSI}0m`;
const INVERT = `${CSI}7m`;
const DIM = `${CSI}2m`;

type TerminalInput = NodeJS.ReadStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};

type TerminalOutput = NodeJS.WriteStream & {
  isTTY?: boolean;
};

export interface RunTerminalRendererOptions {
  stdin?: TerminalInput;
  stdout?: TerminalOutput;
}

export async function runTerminalRenderer(
  app: TuiApp,
  options: RunTerminalRendererOptions = {},
): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  assertInteractiveTerminal(stdin, stdout);

  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    let pending = Promise.resolve();

    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.off("error", onError);
      stdin.pause();
      stdin.setRawMode?.(false);
      stdout.write(`${RESET}${SHOW_CURSOR}`);
    };

    const finish = (code: number): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(code);
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const onError = (error: Error): void => {
      fail(error);
    };

    const onData = (chunk: Buffer | string): void => {
      const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");

      pending = pending
        .then(async () => {
          const shouldExit = await handleKey(app, key);
          if (shouldExit) {
            finish(0);
            return;
          }

          if (!settled) {
            render(app, stdout);
          }
        })
        .catch((error) => fail(error));
    };

    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
    stdin.on("error", onError);
    render(app, stdout);
  });
}

async function handleKey(app: TuiApp, key: string): Promise<boolean> {
  switch (key) {
    case "q":
    case "Q":
    case "\u0003":
      return true;
    case "\r":
    case "\n":
      await app.activate();
      return false;
    case "\u001b[A":
      app.moveRow(-1);
      return false;
    case "\u001b[B":
      app.moveRow(1);
      return false;
    case "\u001b[D":
      app.moveAction(-1);
      return false;
    case "\u001b[C":
      app.moveAction(1);
      return false;
    default:
      return false;
  }
}

function render(app: TuiApp, stdout: TerminalOutput): void {
  const model = app.model();
  const state = app.state();
  const lines: string[] = [
    `${HIDE_CURSOR}${CLEAR_SCREEN}HX Fortress`,
    "",
    ...model.rows.flatMap((row, rowIndex) => renderRow(row, rowIndex, state)),
  ];

  if (state.error) {
    lines.push("");
    lines.push(`error: ${state.error}`);
  }

  lines.push("");
  lines.push(model.footerNote);
  lines.push(`${DIM}Use arrows to move, Enter to activate, q to quit.${RESET}`);
  stdout.write(`${lines.join("\n")}${CLEAR_REMAINDER}`);
}

function renderRow(
  row: MainScreenRow,
  rowIndex: number,
  state: ReturnType<TuiApp["state"]>,
): string[] {
  const selected = rowIndex === state.selectedRow;
  const prefix = selected ? ">" : " ";
  const installed = row.installedVersion ?? "-";
  const available = row.availableVersion ?? "-";

  return [
    `${prefix} ${row.label}  status:${row.statusLabel}  installed:${installed}  available:${available}`,
    `  ${row.actions
      .map((action, actionIndex) =>
        renderAction(action, selected && actionIndex === state.selectedAction),
      )
      .join("  ")}`,
  ];
}

function renderAction(action: MainScreenAction, selected: boolean): string {
  const label = actionLabel(action);
  const disabled = action.enabled ? label : `${label} (disabled)`;

  if (!selected) {
    return `[${disabled}]`;
  }

  return `${INVERT}[${disabled}]${RESET}`;
}

function actionLabel(action: MainScreenAction): string {
  switch (action.kind) {
    case "start":
      return "start";
    case "stop":
      return "stop";
    case "update":
      return `update ${action.version}`;
    case "view-details":
      return "details";
  }
}

function assertInteractiveTerminal(
  stdin: TerminalInput,
  stdout: TerminalOutput,
): void {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error(
      "hx-fortress tui requires an interactive terminal with TTY stdin/stdout.",
    );
  }
}
