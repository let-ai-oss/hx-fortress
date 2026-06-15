import { describe, expect, test } from "bun:test";

import { ModuleRegistry } from "../src/host/module-registry";
import type { HostLogger, Module, ModuleContext } from "../src/host/types";
import type { MsgData, MsgReply } from "../src/protocol";

describe("ModuleRegistry registration", () => {
  test("registers a module and exposes it as stopped", () => {
    const registry = new ModuleRegistry(silentLogger());
    registry.register(fixtureModule({ id: "session_vault" }));

    expect(registry.has("session_vault")).toBe(true);
    expect(registry.get("session_vault")?.id).toBe("session_vault");
    expect(registry.snapshot()).toEqual([
      { id: "session_vault", state: "stopped", error: null },
    ]);
  });

  test("lists modules in registration order", () => {
    const registry = new ModuleRegistry(silentLogger());
    registry.register(fixtureModule({ id: "session_vault" }));
    registry.register(fixtureModule({ id: "analytics" }));

    expect(registry.snapshot().map((module) => module.id)).toEqual([
      "session_vault",
      "analytics",
    ]);
  });

  test("rejects a duplicate module id", () => {
    const registry = new ModuleRegistry(silentLogger());
    registry.register(fixtureModule({ id: "session_vault" }));

    expect(() => registry.register(fixtureModule({ id: "session_vault" }))).toThrow(
      "Module already registered: session_vault",
    );
  });

  test("rejects an invalid module id", () => {
    const registry = new ModuleRegistry(silentLogger());

    expect(() => registry.register(fixtureModule({ id: "Session-Vault" }))).toThrow(
      "Invalid module id: Session-Vault",
    );
  });
});

describe("ModuleRegistry lifecycle", () => {
  test("starts enabled modules in order through init then start", async () => {
    const events: string[] = [];
    const registry = new ModuleRegistry(silentLogger());
    registry.register(
      fixtureModule({
        id: "session_vault",
        init: (context) => {
          events.push(`init:${context.moduleId}`);
        },
        start: () => {
          events.push("start:session_vault");
        },
      }),
    );
    registry.register(
      fixtureModule({
        id: "analytics",
        init: () => {
          events.push("init:analytics");
        },
        start: () => {
          events.push("start:analytics");
        },
      }),
    );

    const results = await registry.startAll(["session_vault", "analytics"]);

    expect(events).toEqual([
      "init:session_vault",
      "start:session_vault",
      "init:analytics",
      "start:analytics",
    ]);
    expect(results).toEqual([
      { id: "session_vault", ok: true },
      { id: "analytics", ok: true },
    ]);
    expect(registry.snapshot()).toEqual([
      { id: "session_vault", state: "running", error: null },
      { id: "analytics", state: "running", error: null },
    ]);
  });

  test("only starts modules named in the enabled list", async () => {
    const registry = new ModuleRegistry(silentLogger());
    registry.register(fixtureModule({ id: "session_vault" }));
    registry.register(fixtureModule({ id: "analytics" }));

    await registry.startAll(["session_vault"]);

    expect(registry.snapshot()).toEqual([
      { id: "session_vault", state: "running", error: null },
      { id: "analytics", state: "stopped", error: null },
    ]);
  });

  test("isolates a failing module so the others still start", async () => {
    const registry = new ModuleRegistry(silentLogger());
    registry.register(
      fixtureModule({
        id: "session_vault",
        start: () => {
          throw new Error("bucket unavailable");
        },
      }),
    );
    registry.register(fixtureModule({ id: "analytics" }));

    const results = await registry.startAll(["session_vault", "analytics"]);

    expect(results).toEqual([
      { id: "session_vault", ok: false, error: "bucket unavailable" },
      { id: "analytics", ok: true },
    ]);
    expect(registry.snapshot()).toEqual([
      { id: "session_vault", state: "failed", error: "bucket unavailable" },
      { id: "analytics", state: "running", error: null },
    ]);
  });

  test("marks an enabled-but-unregistered module as failed", async () => {
    const registry = new ModuleRegistry(silentLogger());
    registry.register(fixtureModule({ id: "session_vault" }));

    const results = await registry.startAll(["session_vault", "ghost"]);

    expect(results).toEqual([
      { id: "session_vault", ok: true },
      { id: "ghost", ok: false, error: "Module not registered: ghost" },
    ]);
    expect(registry.snapshot()).toContainEqual({
      id: "ghost",
      state: "failed",
      error: "Module not registered: ghost",
    });
  });

  test("stops running modules and isolates a failing stop", async () => {
    const events: string[] = [];
    const loggedErrors: Array<[string, string]> = [];
    const registry = new ModuleRegistry(recordingLogger(loggedErrors));
    registry.register(
      fixtureModule({
        id: "session_vault",
        stop: () => {
          throw new Error("flush failed");
        },
      }),
    );
    registry.register(
      fixtureModule({
        id: "analytics",
        stop: () => {
          events.push("stop:analytics");
        },
      }),
    );
    await registry.startAll(["session_vault", "analytics"]);

    const results = await registry.stopAll();

    expect(events).toEqual(["stop:analytics"]);
    expect(results).toEqual([
      { id: "session_vault", ok: false, error: "flush failed" },
      { id: "analytics", ok: true },
    ]);
    expect(registry.snapshot()).toEqual([
      { id: "session_vault", state: "failed", error: "flush failed" },
      { id: "analytics", state: "stopped", error: null },
    ]);
    expect(loggedErrors).toContainEqual([
      "Failed to stop Fortress module: session_vault",
      "flush failed",
    ]);
  });

  test("only stops modules that are running", async () => {
    const events: string[] = [];
    const registry = new ModuleRegistry(silentLogger());
    registry.register(
      fixtureModule({
        id: "analytics",
        stop: () => {
          events.push("stop:analytics");
        },
      }),
    );

    const results = await registry.stopAll();

    expect(events).toEqual([]);
    expect(results).toEqual([]);
  });
});

describe("ModuleRegistry dispatch", () => {
  test("routes a request to the addressed module and returns its reply", async () => {
    const registry = new ModuleRegistry(silentLogger());
    const received: MsgData[] = [];
    registry.register(
      fixtureModule({
        id: "session_vault",
        onMessage: (data) => {
          received.push(data);
          return { ok: true, payload: { signed: true } };
        },
      }),
    );
    await registry.startAll(["session_vault"]);

    const request: MsgData = {
      module: "session_vault",
      id: "req-1",
      kind: "request",
      payload: { method: "selfTest" },
    };
    const reply = await registry.dispatch(request);

    expect(reply).toEqual({ ok: true, payload: { signed: true } });
    expect(received).toEqual([request]);
  });

  test("replies with an error when a request targets an unknown module", async () => {
    const registry = new ModuleRegistry(silentLogger());

    const reply = await registry.dispatch({
      module: "ghost",
      id: "req-1",
      kind: "request",
      payload: null,
    });

    expect(reply).toEqual({ ok: false, error: "Module not running: ghost" });
  });

  test("replies with an error when a request targets a stopped module", async () => {
    const registry = new ModuleRegistry(silentLogger());
    registry.register(fixtureModule({ id: "session_vault" }));

    const reply = await registry.dispatch({
      module: "session_vault",
      id: "req-1",
      kind: "request",
      payload: null,
    });

    expect(reply).toEqual({
      ok: false,
      error: "Module not running: session_vault",
    });
  });

  test("turns a throwing request handler into a failed reply", async () => {
    const registry = new ModuleRegistry(silentLogger());
    registry.register(
      fixtureModule({
        id: "session_vault",
        onMessage: () => {
          throw new Error("vault offline");
        },
      }),
    );
    await registry.startAll(["session_vault"]);

    const reply = await registry.dispatch({
      module: "session_vault",
      id: "req-1",
      kind: "request",
      payload: null,
    });

    expect(reply).toEqual({ ok: false, error: "vault offline" });
  });

  test("fails a request whose handler returns no reply", async () => {
    const registry = new ModuleRegistry(silentLogger());
    registry.register(
      fixtureModule({
        id: "session_vault",
        onMessage: () => undefined,
      }),
    );
    await registry.startAll(["session_vault"]);

    const reply = await registry.dispatch({
      module: "session_vault",
      id: "req-9",
      kind: "request",
      payload: null,
    });

    expect(reply).toEqual({
      ok: false,
      error: "Module returned no reply for request: req-9",
    });
  });

  test("delivers an event without producing a reply", async () => {
    const registry = new ModuleRegistry(silentLogger());
    const received: MsgData[] = [];
    registry.register(
      fixtureModule({
        id: "session_vault",
        onMessage: (data) => {
          received.push(data);
        },
      }),
    );
    await registry.startAll(["session_vault"]);

    const event: MsgData = {
      module: "session_vault",
      id: "evt-1",
      kind: "event",
      payload: { type: "ping" },
    };
    const reply = await registry.dispatch(event);

    expect(reply).toBeUndefined();
    expect(received).toEqual([event]);
  });

  test("swallows and logs a throwing event handler", async () => {
    const loggedErrors: Array<[string, string]> = [];
    const registry = new ModuleRegistry(recordingLogger(loggedErrors));
    registry.register(
      fixtureModule({
        id: "session_vault",
        onMessage: () => {
          throw new Error("handler blew up");
        },
      }),
    );
    await registry.startAll(["session_vault"]);

    const reply = await registry.dispatch({
      module: "session_vault",
      id: "evt-1",
      kind: "event",
      payload: null,
    });

    expect(reply).toBeUndefined();
    expect(loggedErrors).toContainEqual([
      "Module event handler failed: session_vault",
      "handler blew up",
    ]);
  });

  test("drops an event for an unknown module without throwing", async () => {
    const loggedErrors: Array<[string, string]> = [];
    const registry = new ModuleRegistry(recordingLogger(loggedErrors));

    const reply = await registry.dispatch({
      module: "ghost",
      id: "evt-1",
      kind: "event",
      payload: null,
    });

    expect(reply).toBeUndefined();
    expect(loggedErrors.map((entry) => entry[0])).toContain(
      "Dropped event for module not running: ghost",
    );
  });
});

interface FixtureOptions {
  id: string;
  onMessage?: (data: MsgData) => Promise<MsgReply | void> | MsgReply | void;
  init?: (context: ModuleContext) => Promise<void> | void;
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
}

function fixtureModule(options: FixtureOptions): Module {
  return {
    id: options.id,
    init: options.init,
    start: options.start,
    stop: options.stop,
    onMessage:
      options.onMessage ??
      ((data) => ({ ok: true, payload: { echoed: data.payload } })),
  };
}

function silentLogger(): HostLogger {
  return { error() {} };
}

function recordingLogger(sink: Array<[string, string]>): HostLogger {
  return {
    error(message, error) {
      sink.push([message, error instanceof Error ? error.message : String(error)]);
    },
  };
}
