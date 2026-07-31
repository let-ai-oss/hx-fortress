// The write surface: the two ways a console operator changes something, and the
// wall between them.
//
// SERVICE CONTROL RUNS IN THIS PROCESS. Start, stop and restart are calls into
// the host's service manager, because the thing being controlled is the daemon
// and a stopped daemon polls for nothing — a command row asking a dead process
// to start itself would sit in the queue until its deadline and be rejected.
//
// EVERYTHING ELSE IS A ROW THE DAEMON EXECUTES. The console holds no vault
// credential, no signing key and no store handle; work that needs one is
// REQUESTED here and performed there, and the console renders the daemon's own
// answer rather than a claim of its own. Minting the row is the console role's
// exclusive privilege, which is what keeps the cloud-reachable write role unable
// to ask for a self-update or a rotation.
//
// Every route here is `mutate`, so the gate answers a readonly session with the
// server's own refusal sentence — the same words the disabled control carries.

import { validateCommandParams, type CommandParams } from "../console/command-params";
import { AUDIT_ACTIONS } from "../console/audit-actions";
import { heartbeatFresh } from "../console/commands";
import { CONTAINER_SERVICE_REFUSAL, NO_POLLER_REFUSAL } from "./copy";
import { redactValue } from "./redact";
import type { ConsoleAudit } from "./audit-writer";
import type { RouteSpec } from "./routes";
import type { ConsoleCommandKind } from "../host/postgres/console-plane";

export const MUTATE_PATHS = {
  service: "/ui/api/service",
  commands: "/ui/api/commands",
} as const;

export const MUTATE_ROUTES: readonly RouteSpec[] = [
  { method: "POST", path: MUTATE_PATHS.service, cls: "mutate" },
  { method: "POST", path: MUTATE_PATHS.commands, cls: "mutate" },
];

/** The kinds this console has a control for. Later work adds its own kind here
 *  alongside the control that submits it; a kind with no control is refused by
 *  name rather than queued for an executor nothing drives. */
export const OFFERED_COMMAND_KINDS: readonly ConsoleCommandKind[] = ["update_apply", "self_test"];

export const SERVICE_ACTIONS = ["start", "stop", "restart"] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

export function isServiceAction(value: unknown): value is ServiceAction {
  return typeof value === "string" && (SERVICE_ACTIONS as readonly string[]).includes(value);
}

export { CONTAINER_SERVICE_REFUSAL, NO_POLLER_REFUSAL };

export interface ServiceResult {
  action: ServiceAction;
  manager: string;
  pid: number | null;
  /** The sentence the console renders in place, from the server. */
  copy: string;
}

/**
 * Everything the write handlers may do. Deliberately tiny, and deliberately
 * separate from the read port: the read class is defined by an interface that
 * cannot express a write, and that argument only holds while the two stay apart.
 */
export interface ConsoleWritePort {
  /** Null on a host with a unit; the reason otherwise. */
  serviceRefusal(): string | null;
  service(action: ServiceAction): Promise<ServiceResult>;
  /** The daemon's last heartbeat, for the poller check. */
  heartbeatAt(): Promise<string | null>;
  /** Mint one console_commands row, attributed to the signed-in operator. */
  submit(
    kind: ConsoleCommandKind,
    params: CommandParams,
    requestedBy: string,
  ): Promise<{ id: string }>;
  /** The kinds this console offers a control for. A kind outside it is refused
   *  by name rather than queued for an executor nothing drives. */
  offered(): readonly ConsoleCommandKind[];
}

export interface MutateRouteContext {
  port: ConsoleWritePort;
  audit: ConsoleAudit;
  actor: string;
  sessionId: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(redactValue(body))}\n`, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function refusal(reason: string, status = 400): Response {
  return json({ error: reason }, status);
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Null when the path is not a write route — the caller falls through. */
export async function handleMutateRoute(
  req: Request,
  ctx: MutateRouteContext,
): Promise<Response | null> {
  if (req.method !== "POST") return null;
  const path = new URL(req.url).pathname;

  if (path === MUTATE_PATHS.service) {
    const body = await readBody(req);
    const action = body?.action;
    if (!isServiceAction(action)) {
      return refusal(`action must be one of ${SERVICE_ACTIONS.join(", ")}`);
    }
    const blocked = ctx.port.serviceRefusal();
    if (blocked) return refusal(blocked, 409);
    try {
      const result = await ctx.audit.run(
        `${AUDIT_ACTIONS.servicePrefix}${action}`,
        { actor: ctx.actor, sessionRef: ctx.sessionId, params: { action } },
        () => ctx.port.service(action),
      );
      return json(result);
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error), 500);
    }
  }

  if (path === MUTATE_PATHS.commands) {
    const body = await readBody(req);
    const kind = body?.kind;
    const checked = validateCommandParams(kind, body?.params ?? {});
    if (!checked.ok) return refusal(checked.reason);
    if (!ctx.port.offered().includes(checked.kind)) {
      return refusal(`this console has no control for ${checked.kind}`, 404);
    }
    if (!heartbeatFresh(await ctx.port.heartbeatAt())) return refusal(NO_POLLER_REFUSAL, 409);
    try {
      const submitted = await ctx.audit.run(
        AUDIT_ACTIONS.commandSubmitted,
        {
          actor: ctx.actor,
          sessionRef: ctx.sessionId,
          params: { commandKind: checked.kind, ...checked.params },
        },
        () => ctx.port.submit(checked.kind, checked.params, ctx.actor),
      );
      // The row is a REQUEST. The console renders its outcome from the daemon's
      // own record, never from the fact that the request was accepted.
      return json({ id: submitted.id, kind: checked.kind, status: "requested" }, 202);
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error), 500);
    }
  }

  return null;
}
