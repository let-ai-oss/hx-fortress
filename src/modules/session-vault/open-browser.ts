// Best-effort browser opener for the device-auth flow. A failed open must
// never throw — the caller always prints the URL as a fallback.
//
// `url` comes straight off the gateway response, so it's untrusted: never hand
// it to a shell (a value like "https://x/$(...)" would execute), and only ever
// open http(s). Validate the scheme, then spawn with an argv array so the URL
// is a single non-shell argument.

import { spawn } from "node:child_process";
import os from "node:os";

export async function openBrowser(url: string): Promise<void> {
  try {
    const scheme = new URL(url).protocol;
    if (scheme !== "http:" && scheme !== "https:") return;
  } catch {
    return;
  }

  const platform = os.platform();
  const [cmd, args]: [string, string[]] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Swallow — the URL is printed to the terminal regardless.
  }
}
