// Minimal interactive prompt kit for the Session Vault enroll wizard. Reads the
// controlling terminal (the installer rebinds stdin to /dev/tty), so prompts
// work even under `curl … | sh`. Node built-ins only — no dependencies.
//
// Cooked-mode prompts (text, confirm) use readline; raw-mode prompts (select,
// password) drive the terminal directly. Every prompt restores cooked mode on
// exit, so they compose in sequence.

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";

const ESC = "\x1b";

/** True when an interactive terminal is attached. The wizard only prompts when
 *  this holds; otherwise the CLI falls back to flag-driven enrollment. */
export function ttyAvailable(): boolean {
  return Boolean(stdin.isTTY);
}

function write(s: string): void {
  stdout.write(s);
}

/** Free-text input with an optional default (Enter accepts the default). */
export function textPrompt(message: string, opts: { default?: string } = {}): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const suffix = opts.default ? ` [${opts.default}]` : "";
  return new Promise((resolve) => {
    rl.question(`${message}${suffix} `, (answer) => {
      rl.close();
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
    stdin.setRawMode?.(true);
    stdin.resume();
    let buf = "";
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
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
    stdin.on("data", onData);
  });
}

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

/** Arrow-key select, with optional type-to-filter. Returns the chosen value. */
export function selectPrompt<T>(
  message: string,
  choices: Choice<T>[],
  opts: { filter?: boolean; defaultIndex?: number } = {},
): Promise<T> {
  return new Promise((resolve) => {
    let filter = "";
    let index = opts.defaultIndex ?? 0;
    let lastLines = 0;

    const visible = (): Choice<T>[] =>
      opts.filter && filter
        ? choices.filter((c) => c.label.toLowerCase().includes(filter.toLowerCase()))
        : choices;

    const render = (): void => {
      if (lastLines > 0) write(`${ESC}[${lastLines}A`);
      write(`${ESC}[0J`); // clear from cursor to end of screen
      const list = visible();
      if (index >= list.length) index = Math.max(0, list.length - 1);
      const out: string[] = [
        `${message}${opts.filter ? (filter ? `  (filter: ${filter})` : "  (type to filter)") : ""}`,
      ];
      if (list.length === 0) out.push("  (no matches)");
      list.forEach((c, i) => {
        const prefix = i === index ? "❯ " : "  ";
        out.push(`${prefix}${c.label}${c.hint ? `  ${c.hint}` : ""}`);
      });
      write(`${out.join("\n")}\n`);
      lastLines = out.length;
    };

    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
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

    stdin.setRawMode?.(true);
    stdin.resume();
    render();
    stdin.on("data", onData);
  });
}
