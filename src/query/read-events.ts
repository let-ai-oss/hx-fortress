// A4 · hx_session_read_events — whole-object local parse of one in-scope
// session's canonical transcript (NOW: O(session); byte-offset O(window) is
// FUTURE). Three read shapes:
//   • get-by-type   — filterType, sourced from the persisted `kind` taxonomy;
//                     reaches ANY turn incl. tool_result (readable, never embedded)
//   • full          — fromIndex/maxEvents window over the (filtered) event list
//   • get-by-offset — charOffset/length slices the target turn's full text
//                     (serves windows past the per-turn MAX_TEXT cap)
//
// The session is resolved under the passed scope (A6) on its live row, then read
// from the fortress's OWN store (co-located blob — no whole-blob over the wire)
// and re-parsed with the SAME shared classifier the write path persisted `kind`
// from (src/ingest/classify.ts), so get-by-type and the re-parsed text align.

import { and, eq } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessions, hxUsers } from "../host/postgres/schema";
import { classifyChunk, type ClassifiedEvent } from "../ingest/classify";
import type { SessionStore } from "../modules/session-vault/store/types";
import { scopePredicate, type FortressScope } from "./scope";

export interface ReadEventsInput {
  scope: FortressScope;
  sessionId: string;
  filterType?: string;
  fromIndex?: number;
  maxEvents?: number;
  charOffset?: number;
  length?: number;
}

export interface ReadEvent {
  index: number;
  kind: ClassifiedEvent["kind"];
  role: ClassifiedEvent["role"];
  ts: string | null;
  toolName: string | null;
  isError: boolean;
  text: string;
  charOffset?: number;
}

export interface ReadEventsResult {
  events: ReadEvent[];
  total: number;
  nextIndex?: number | null;
  error?: string;
  detail?: string;
}

const DEFAULT_MAX_EVENTS = 50;
const MAX_MAX_EVENTS = 200;
const FULL_TEXT_CAP = 1500; // bound token usage on full/get-by-type reads
const DEFAULT_OFFSET_LEN = 500;
const MAX_OFFSET_LEN = 4000;

function capText(text: string): string {
  if (text.length <= FULL_TEXT_CAP) return text;
  return `${text.slice(0, FULL_TEXT_CAP)}… [${text.length - FULL_TEXT_CAP} more chars]`;
}

function mapEvent(e: ClassifiedEvent, index: number, text: string, charOffset?: number): ReadEvent {
  const base: ReadEvent = {
    index,
    kind: e.kind,
    role: e.role,
    ts: e.ts,
    toolName: e.toolName,
    isError: e.isError,
    text,
  };
  return charOffset === undefined ? base : { ...base, charOffset };
}

export async function hxSessionReadEvents(
  db: HxDb,
  store: SessionStore | null,
  input: ReadEventsInput,
): Promise<ReadEventsResult> {
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  if (!sessionId) return { events: [], total: 0, error: "session_not_found" };

  const rows = await db
    .select({
      family: hxSessions.family,
      sessionId: hxSessions.sessionId,
      userExternalId: hxUsers.externalId,
    })
    .from(hxSessions)
    .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
    .where(and(scopePredicate(input.scope), eq(hxSessions.sessionId, sessionId)))
    .limit(1);

  const session = rows[0];
  if (!session) return { events: [], total: 0, error: "session_not_found" };
  if (!store) return { events: [], total: 0, error: "vault_unavailable" };

  let text: string;
  try {
    text = await store.readCanonicalText({
      userId: session.userExternalId,
      family: session.family,
      sessionId: session.sessionId,
    });
  } catch (err) {
    return {
      events: [],
      total: 0,
      error: "session_read_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const all = classifyChunk(text);
  const filtered = input.filterType ? all.filter((e) => e.kind === input.filterType) : all;
  const total = filtered.length;

  // get-by-offset: a turn-relative window into one event's full text.
  if (typeof input.charOffset === "number") {
    const idx = Math.max(0, input.fromIndex ?? 0);
    const ev = filtered[idx];
    if (!ev) return { events: [], total };
    const start = Math.max(0, input.charOffset);
    const len = Math.min(Math.max(1, input.length ?? DEFAULT_OFFSET_LEN), MAX_OFFSET_LEN);
    const window = (ev.text ?? "").slice(start, start + len);
    return { events: [mapEvent(ev, idx, window, start)], total };
  }

  // full / get-by-type: a window over the (filtered) event list.
  const fromIndex = Math.max(0, input.fromIndex ?? 0);
  const maxEvents = Math.min(Math.max(1, input.maxEvents ?? DEFAULT_MAX_EVENTS), MAX_MAX_EVENTS);
  const slice = filtered.slice(fromIndex, fromIndex + maxEvents);
  const nextIndex = fromIndex + maxEvents < total ? fromIndex + maxEvents : null;

  return {
    events: slice.map((e, i) => mapEvent(e, fromIndex + i, capText(e.text ?? ""))),
    total,
    nextIndex,
  };
}
