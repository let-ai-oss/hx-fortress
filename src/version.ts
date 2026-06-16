// The one source of truth for "which build of hx-fortress is this": a single
// monotonically increasing integer. `hx-fortress version` prints it as "hx-fortress version: <N>.0.0".
//
// Bumping
// -------
// Increment whenever a change to the fortress binary is something a user could
// observe — a new or changed command, a fixed bug, a behavior change. The number
// must only ever increase.
export const FORTRESS_VERSION = 1;
