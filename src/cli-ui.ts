// `hx-fortress ui` — serve the administration console, and dispatch its verbs.
//
// Serving prints exactly four things: what it is serving (the asset manifest, so
// a running console can be matched against a release), what anyone who signs in
// will be able to see, where it is listening, and how to reach it. It never
// prints a credential, and the surface it serves discloses nothing before
// sign-in.
//
// Before it binds, it takes a ROOT-SCOPED instance lock. Two consoles on one
// fortress root would each own the user store and each hold sessions the other
// cannot revoke, so the second refuses regardless of which port it was given. A
// busy PORT is a different failure with a different remedy, and it is diagnosed
// separately by asking the occupant to identify itself.

import os from "node:os";
import path from "node:path";

import { fortressPaths } from "./host/paths";
import { isUiSubcommand, runUiVerb } from "./cli-ui-verbs";
import { loadUiAssets, type UiAssets } from "./ui/assets";
import {
  bracketed,
  DEFAULT_UI_PORT,
  LOOPBACK_BIND,
  DUAL_STACK_FALLBACK_BIND,
  printedUrl,
  resolveUiBind,
} from "./ui/bind";
import { LiveUiConfig, UiConfigColdStartError } from "./ui/config";
import { detectContainer } from "./ui/container";
import { PEOPLE_VISIBILITY_DISCLOSURE } from "./ui/copy";
import { acquireInstanceLock, portCollisionMessage, probeOccupant } from "./ui/instance";
import { UiRuntime } from "./ui/runtime";
import { startUiServer, type UiServerCtx } from "./ui/server";

type WriteLine = (line: string) => void;

export interface UiCommandDeps {
  writeLine: WriteLine;
  env?: Record<string, string | undefined>;
  platform?: string;
  /** os.hostname(), quoted into the SSH one-liner. */
  hostName?: string;
  /** Overrides the fortress root — the console's state lives under <root>/ui. */
  fortressRoot?: string;
  loadAssets?: () => Promise<UiAssets | null>;
  /** Injected in tests; reports the port actually bound. */
  serve?: (
    ctx: UiServerCtx,
    hostname: string,
    fallbackHostname?: string,
  ) => { readonly port?: number | null };
}

interface UiFlags {
  port: number | null;
  bind: string | null;
  url: string | null;
  allowInsecureBind: boolean;
  noContainer: boolean;
  /** Set by the unit's ExecStart and by the container supervisor. A supervised
   *  console honors the enablement belt; a foreground one is self-authorizing —
   *  otherwise a fresh install (no ui.json, no env) would print a URL and exit on
   *  its first request. */
  supervised: boolean;
}

function parseFlags(args: readonly string[], env: Record<string, string | undefined>): UiFlags {
  const flags: UiFlags = {
    port: null,
    bind: env.FORTRESS_UI_BIND?.trim() || null,
    url: null,
    allowInsecureBind: false,
    noContainer: false,
    supervised: false,
  };

  const envPort = env.FORTRESS_UI_PORT?.trim();
  if (envPort) flags.port = portOrThrow(envPort);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    switch (arg) {
      case "--port":
        flags.port = portOrThrow(args[i + 1]);
        i += 1;
        break;
      case "--bind":
        flags.bind = requireValue(arg, args[i + 1]);
        i += 1;
        break;
      case "--url":
        flags.url = requireValue(arg, args[i + 1]);
        i += 1;
        break;
      case "--allow-insecure-bind":
        flags.allowInsecureBind = true;
        break;
      case "--no-container":
        flags.noContainer = true;
        break;
      case "--supervised":
        flags.supervised = true;
        break;
      default:
        throw new Error(
          `unknown option ${arg}\n` +
            "usage: hx-fortress ui [--port <n>] [--bind <addr>] [--url <base>] " +
            "[--allow-insecure-bind] [--no-container] [--supervised]",
        );
    }
  }
  return flags;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function portOrThrow(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${value ?? ""}`);
  }
  return port;
}

function humanBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} kB`;
}

export async function runUiCommand(
  args: readonly string[],
  deps: UiCommandDeps,
): Promise<number> {
  if (isUiSubcommand(args[0])) {
    return await runUiVerb(args, {
      writeLine: deps.writeLine,
      env: deps.env,
      fortressRoot: deps.fortressRoot,
      platform: deps.platform,
      hostName: deps.hostName,
    });
  }

  const env = deps.env ?? process.env;
  const write = deps.writeLine;
  const flags = parseFlags(args, env);
  const paths = fortressPaths(deps.fortressRoot);

  const assets = await (deps.loadAssets ?? loadUiAssets)();
  if (!assets) {
    write("error: the console assets are missing from this build.");
    write("Build them with `bun run build:ui && bun run gen:ui`, or install a released binary.");
    return 1;
  }

  // A cold start against an unparseable ui.json refuses by name. There is no last
  // good value yet, and the one fallback available — pg.json's DSN — would
  // connect the browser-facing console as the table-owning role while silently
  // dropping trustedProxies and publicUrl.
  const live = new LiveUiConfig(paths.uiConfig, (message) => write(`warning: ${message}`));
  let stored;
  try {
    stored = await live.read();
  } catch (err) {
    if (err instanceof UiConfigColdStartError) {
      write(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const port = flags.port ?? stored.port ?? DEFAULT_UI_PORT;
  const publicUrl = env.FORTRESS_UI_PUBLIC_URL?.trim() || stored.publicUrl;
  const container = detectContainer({
    env,
    platform: deps.platform,
    noContainerFlag: flags.noContainer,
  });

  const bind = resolveUiBind({
    bind: flags.bind ?? stored.bind ?? LOOPBACK_BIND,
    port,
    publicUrl,
    uiEnable: env.FORTRESS_UI_ENABLE === "1" || env.FORTRESS_UI_ENABLE === "true",
    containerBind: env.FORTRESS_UI_CONTAINER_BIND === "1",
    allowInsecureBind: flags.allowInsecureBind,
    container,
  });

  if (!bind.ok) {
    write(`error: ${bind.reason}`);
    for (const note of bind.notes) write(`  ${note}`);
    return 1;
  }

  const lock = await acquireInstanceLock(path.join(paths.uiRoot, "instance.lock"), port);
  if (!lock.ok) {
    write(`error: ${lock.message}`);
    return 1;
  }

  const runtime = new UiRuntime({
    uiRoot: paths.uiRoot,
    uiConfigFile: paths.uiConfig,
    cmdCredsDir: paths.cmdCreds,
    env,
    onWarn: (message) => write(`warning: ${message}`),
  });
  await runtime.restoreLockouts();

  const ctx: UiServerCtx = { assets, port, runtime };
  let started: { readonly port?: number | null };
  try {
    started = (deps.serve ?? startUiServer)(
      ctx,
      bind.hostname,
      bind.dualStack ? DUAL_STACK_FALLBACK_BIND : undefined,
    );
  } catch (err) {
    await lock.release();
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    // A busy port is a DIFFERENT failure from a second console on this root, and
    // the remedy depends on who is holding it — so ask.
    const occupant = await probeOccupant(`http://127.0.0.1:${port}`);
    write(`error: ${portCollisionMessage(port, occupant)}`);
    return 1;
  }

  runtime.startSweepTimer();

  const boundPort = started.port ?? port;
  const url = printedUrl({
    urlOverride: flags.url,
    publicUrl,
    hostname: bind.hostname,
    dualStack: bind.dualStack,
    port: boundPort,
    hostName: deps.hostName ?? os.hostname(),
  });

  write("HX Fortress console");
  write(
    `  assets: ${assets.mode}, ${assets.manifest.files} files, ` +
      `${humanBytes(assets.manifest.bytes)}, sha256 ${assets.manifest.hash}`,
  );
  write(`  listening on ${bracketed(bind.hostname)}:${boundPort}`);
  for (const line of PEOPLE_VISIBILITY_DISCLOSURE) write(line);
  write(`  open ${url.base}`);
  for (const note of [...url.notes, ...bind.notes]) write(`  ${note}`);
  if (flags.supervised) {
    write("  supervised: it stops when `hx-fortress ui disable` flips the setting");
  }
  return 0;
}
