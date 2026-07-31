// `hx-fortress ui` — serve the administration console.
//
// The verb prints exactly three things: what it is serving (the asset manifest,
// so a running console can be matched against a release), where it is listening,
// and how to reach it. It never prints a credential, and the surface it serves
// discloses nothing before sign-in.

import os from "node:os";

import { loadUiAssets, type UiAssets } from "./ui/assets";
import {
  bracketed,
  DEFAULT_UI_PORT,
  LOOPBACK_BIND,
  DUAL_STACK_FALLBACK_BIND,
  printedUrl,
  resolveUiBind,
} from "./ui/bind";
import { detectContainer } from "./ui/container";
import { startUiServer, type UiServerCtx } from "./ui/server";

type WriteLine = (line: string) => void;

export interface UiCommandDeps {
  writeLine: WriteLine;
  env?: Record<string, string | undefined>;
  platform?: string;
  /** os.hostname(), quoted into the SSH one-liner. */
  hostName?: string;
  loadAssets?: () => Promise<UiAssets | null>;
  /** Injected in tests; reports the port actually bound. */
  serve?: (
    ctx: UiServerCtx,
    hostname: string,
    fallbackHostname?: string,
  ) => { readonly port?: number | null };
}

interface UiFlags {
  port: number;
  bind: string | null;
  url: string | null;
  allowInsecureBind: boolean;
  noContainer: boolean;
}

function parseFlags(args: readonly string[], env: Record<string, string | undefined>): UiFlags {
  const flags: UiFlags = {
    port: DEFAULT_UI_PORT,
    bind: env.FORTRESS_UI_BIND?.trim() || null,
    url: null,
    allowInsecureBind: false,
    noContainer: false,
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
      default:
        throw new Error(
          `unknown option ${arg}\n` +
            "usage: hx-fortress ui [--port <n>] [--bind <addr>] [--url <base>] " +
            "[--allow-insecure-bind] [--no-container]",
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
  const env = deps.env ?? process.env;
  const write = deps.writeLine;
  const flags = parseFlags(args, env);

  const assets = await (deps.loadAssets ?? loadUiAssets)();
  if (!assets) {
    write("error: the console assets are missing from this build.");
    write("Build them with `bun run build:ui && bun run gen:ui`, or install a released binary.");
    return 1;
  }

  const container = detectContainer({
    env,
    platform: deps.platform,
    noContainerFlag: flags.noContainer,
  });

  const bind = resolveUiBind({
    bind: flags.bind ?? LOOPBACK_BIND,
    port: flags.port,
    publicUrl: env.FORTRESS_UI_PUBLIC_URL?.trim() || null,
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

  const ctx: UiServerCtx = { assets, port: flags.port };
  const started = (deps.serve ?? startUiServer)(
    ctx,
    bind.hostname,
    bind.dualStack ? DUAL_STACK_FALLBACK_BIND : undefined,
  );

  const boundPort = started.port ?? flags.port;
  const url = printedUrl({
    urlOverride: flags.url,
    publicUrl: env.FORTRESS_UI_PUBLIC_URL?.trim() || null,
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
  write(`  open ${url.base}`);
  for (const note of [...url.notes, ...bind.notes]) write(`  ${note}`);
  return 0;
}
