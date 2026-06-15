# Vendored protocol boundary

This directory is the temporary local source of the HX Fortress wire contract.
It is intended to become the public `@let-ai/hx-protocol` package and must
remain the only protocol import surface used by the rest of this repository.

The initial contract is derived from:

- `let-forge/packages/session-store/src/tunnel.ts`
- the generalized `MsgData` and `MsgReply` model in the MC-2253 plan

Only transport-neutral wire types and JSON encoding belong here. WebSocket
dialing, enrollment persistence, authentication orchestration, heartbeat
scheduling, and reconnect backoff belong to the Fortress cloud-connection
layer. Vault RPC requests, results, and handlers belong to the
`session_vault` module.

When `@let-ai/hx-protocol` is published, replace this directory's exports with
package re-exports so callers outside this directory do not need to change.
