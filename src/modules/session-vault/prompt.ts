// Minimal interactive prompt kit for the Session Vault enroll wizard.
// Opens /dev/tty directly for all prompts — this works even when the process
// is exec'd with `</dev/tty` by the install script (curl … | sh), where
// Bun compiled binaries do not reliably expose setRawMode on process.stdin.
//
// Cooked-mode prompts (text, confirm) use readline; raw-mode prompts (select,
// password) drive the terminal directly. Every prompt closes its /dev/tty fd
// on exit, so they compose in sequence.

import { createInterface } from "node:readline";
import { stdout } from "node:process";
import { ReadStream } from "node:tty";
import { openSync, closeSync } from "node:fs";

const ESC = "\x1b";

/** True when /dev/tty is accessible — the wizard only prompts when this holds. */
export function ttyAvailable(): boolean {
  try {
    closeSync(openSync("/dev/tty", "r"));
    return true;
  } catch {
    return false;
  }
}

function write(s: string): void {
  stdout.write(s);
}

function openTty(): ReadStream {
  return new ReadStream(openSync("/dev/tty", "r+"));
}

/** Free-text input with an optional default (Enter accepts the default). */
export function textPrompt(message: string, opts: { default?: string } = {}): Promise<string> {
  const tty = openTty();
  const rl = createInterface({ input: tty, output: stdout });
  const suffix = opts.default ? ` [${opts.default}]` : "";
  return new Promise((resolve) => {
    rl.question(`${message}${suffix} `, (answer) => {
      rl.close();
      tty.destroy();
      resolve(answer.trim() || opts.default || "");
    });
  });
}

/** Yes/no with a default selected by Enter. */
export async function confirmPrompt(
  message: string,
  opts: { default?: boolean } = {},
): Promise<boolean> {
  const def = opts.default ?? true;
  const ans = (await textPrompt(`${message} ${def ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
  if (!ans) return def;
  return ans.startsWith("y");
}

/** Hidden input for secrets — characters are not echoed. */
export function passwordPrompt(message: string): Promise<string> {
  return new Promise((resolve) => {
    write(`${message} `);
    const tty = openTty();
    tty.setRawMode(true);
    tty.resume();
    let buf = "";
    const cleanup = (): void => {
      tty.off("data", onData);
      tty.setRawMode(false);
      tty.destroy();
    };
    const onData = (d: Buffer): void => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\x03") {
          cleanup();
          write("\n");
          process.exit(130);
        }
        if (ch === "\x7f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    tty.on("data", onData);
  });
}

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

/** Arrow-key select with optional type-to-filter and 1–9 number shortcuts.
 *  In non-filter mode pressing a digit immediately picks that option.
 *  Returns the chosen value. */
export function selectPrompt<T>(
  message: string,
  choices: Choice<T>[],
  opts: { filter?: boolean; defaultIndex?: number } = {},
): Promise<T> {
  return new Promise((resolve) => {
    const tty = openTty();
    let filter = "";
    let index = opts.defaultIndex ?? 0;
    let lastLines = 0;

    const visible = (): Choice<T>[] =>
      opts.filter && filter
        ? choices.filter((c) => c.label.toLowerCase().includes(filter.toLowerCase()))
        : choices;

    const render = (): void => {
      if (lastLines > 0) write(`${ESC}[${lastLines}A`);
      write(`${ESC}[0J`);
      const list = visible();
      if (index >= list.length) index = Math.max(0, list.length - 1);
      const out: string[] = [
        `${message}${opts.filter ? (filter ? `  (filter: ${filter})` : "  (type to filter)") : ""}`,
      ];
      if (list.length === 0) out.push("  (no matches)");
      list.forEach((c, i) => {
        const prefix = i === index ? "❯ " : "  ";
        out.push(`${prefix}${i + 1}) ${c.label}${c.hint ? `  ${c.hint}` : ""}`);
      });
      write(`${out.join("\n")}\n`);
      lastLines = out.length;
    };

    const cleanup = (): void => {
      tty.off("data", onData);
      tty.setRawMode(false);
      tty.destroy();
    };

    const onData = (d: Buffer): void => {
      const s = d.toString("utf8");
      const list = visible();
      const n = Math.max(1, list.length);
      if (s === `${ESC}[A` || s === `${ESC}OA`) {
        index = (index - 1 + n) % n;
        render();
        return;
      }
      if (s === `${ESC}[B` || s === `${ESC}OB`) {
        index = (index + 1) % n;
        render();
        return;
      }
      if (s === "\r" || s === "\n") {
        const choice = list[index];
        if (choice) {
          cleanup();
          write("\n");
          resolve(choice.value);
        }
        return;
      }
      if (s === "\x03") {
        cleanup();
        write("\n");
        process.exit(130);
      }
      // Digit shortcuts: only in non-filter mode to avoid conflicting with typing.
      if (!opts.filter && s >= "1" && s <= "9") {
        const pick = list[Number(s) - 1];
        if (pick) {
          index = Number(s) - 1;
          render();
          cleanup();
          write("\n");
          resolve(pick.value);
          return;
        }
      }
      if (opts.filter) {
        if (s === "\x7f" || s === "\b") {
          filter = filter.slice(0, -1);
          index = 0;
          render();
        } else if (s >= " " && s.length === 1) {
          filter += s;
          index = 0;
          render();
        }
      }
    };

    tty.setRawMode(true);
    tty.resume();
    render();
    tty.on("data", onData);
  });
}
