# hx-fortress

HX Fortress is the on-customer-infrastructure host for let.ai components. It
runs as a long-lived Bun process, owns the connection to let.ai cloud, and
loads component modules such as `session_vault`.

This repository currently contains the vendored Fortress/cloud protocol
boundary, the host runtime with its stable on-disk configuration and status
contracts, and the lifecycle CLI for running Fortress as a persistent per-user
launchd or systemd service. Structured logs, module loading, and cloud
transport are implemented. Release artifacts bundle the core `session_vault`
module; `update` and the installer remain follow-up tasks.

## Install

The distribution installer will be served from the customer's let.ai
Workbench origin:

```sh
curl -fsSL https://<workbench-origin>/install/hx-fortress.sh | sh
```

## Commands

The Fortress CLI surface is:

```text
hx-fortress start
hx-fortress stop
hx-fortress status
hx-fortress logs
hx-fortress update
```

`hx-fortress host` is the internal foreground command used by the OS service
manager. It is not intended for direct user invocation.

## Development

Install Bun, then run:

```sh
bun install
bun test
bun run typecheck
bun run lint
```

Use `bun run check` to run all repository checks in the same order as CI.
