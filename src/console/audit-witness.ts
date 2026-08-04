// The audit engine's witness, as it actually reaches let.ai.
//
// The direction is fixed by the protocol: the FORTRESS asks and the hub answers
// (`fortressQuery` rides the fortress→hub union), because `letaiCopy` is a fact
// about the hub's own session rows that this box cannot see.
//
// Two properties this adapter exists to hold:
//
//   AN UNANSWERED QUESTION IS NOT A NEGATIVE ANSWER. Every failure the transport
//   has — a timeout, a closed socket, a saturated registry, and above all a hub
//   too old to recognise the frame, which answers nothing at all — collapses to
//   `null`. The engine renders that as "the witness was not asked", by name. A
//   `false` in its place would print "let.ai reports no copy" about a question
//   nobody ever put.
//
//   A PARTIAL ANSWER IS ALSO NOT AN ANSWER. Ids go out in batches, and a batch
//   that fails after earlier ones succeeded abandons the whole run's witness
//   rather than returning what came back: the sessions in the failed batch would
//   otherwise be absent from `copies` for the same reason a session with no copy
//   is, and the engine cannot tell those two apart.
//
// Batches are serial, one in flight, because the ids are this organization's
// data and the budget that bounds an audit of a large fortress is the same
// budget that keeps it from becoming an outage of it.

import type { WitnessAnswer } from "./audit-engine";
import { WITNESS_MAX_IDS, type FortressQueryPayload, type FortressQueryResultPayload } from "../protocol";

export interface WitnessClientDeps {
  /** The tunnel's bounded ask. Absent on a transport that cannot ask at all,
   *  which is reported as unavailable rather than as a clean answer. */
  request?: (query: FortressQueryPayload, timeoutMs?: number) => Promise<FortressQueryResultPayload>;
  /** Called once per run that could not be answered, with the reason as the
   *  transport named it. */
  onUnavailable?: (reason: string) => void;
  batchSize?: number;
}

/**
 * Ask let.ai about a batch of eligible session ids.
 *
 * Returns null — never a partial or empty answer — the moment any batch cannot
 * be answered.
 */
export function createWitnessClient(
  deps: WitnessClientDeps,
): (ids: readonly string[]) => Promise<WitnessAnswer | null> {
  // The cap comes from the protocol package, not from a local 500. It is part of
  // the contract — a request carrying more MUST be refused rather than shortened
  // — and two repositories that release separately, each holding its own copy of
  // the number, are one release apart from a question the asking side believes
  // is whole and the answering side silently truncates.
  const batchSize = deps.batchSize ?? WITNESS_MAX_IDS;
  return async (ids) => {
    const ask = deps.request;
    if (!ask) {
      deps.onUnavailable?.("this fortress has no cloud transport to ask");
      return null;
    }
    // No ids is a complete answer about nothing: the run asked everything it was
    // allowed to ask, and every eligible session is accounted for.
    if (ids.length === 0) return { copies: new Set<string>(), known: new Set<string>() };

    const copies = new Set<string>();
    const known = new Set<string>();
    for (let from = 0; from < ids.length; from += batchSize) {
      const batch = ids.slice(from, from + batchSize);
      let result: FortressQueryResultPayload;
      try {
        result = await ask({ kind: "residencyWitness", sessionIds: [...batch] });
      } catch (err) {
        deps.onUnavailable?.(err instanceof Error ? err.message : String(err));
        return null;
      }
      // A hub that answered a DIFFERENT question has not answered this one. The
      // shape is checked rather than trusted because the alternative is reading
      // an absent array as "no copies".
      const answers = result.kind === "residencyWitness" ? result.residencyWitness : undefined;
      if (!Array.isArray(answers)) {
        deps.onUnavailable?.("the hub answered without a residency witness");
        return null;
      }
      for (const answer of answers) {
        if (answer.letaiCopy) copies.add(answer.sessionId);
        if (answer.anyDestinationRecord) known.add(answer.sessionId);
      }
    }
    return { copies, known };
  };
}
