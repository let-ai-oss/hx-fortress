import { describe, expect, test } from "bun:test";

import { createTuiApp } from "../src/tui/app";
import { buildMainScreenModel } from "../src/tui/model";

describe("createTuiApp", () => {
  test("exposes the model for a renderer to consume", () => {
    const model = buildMainScreenModel({
      service: { loaded: false, pid: null },
      snapshot: null,
      installedModules: [],
      updates: {},
    });
    const app = createTuiApp({
      model,
      actions: {
        start: async () => {},
        stop: async () => {},
        update: async () => {},
      },
    });

    expect(app.model()).toBe(model);
  });

  test("wraps rows and resets the selected action when the row changes", () => {
    const app = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: true, pid: 1234 },
        snapshot: null,
        installedModules: [],
        updates: {
          session_vault: { kind: "module", version: "1.2.4" },
        },
      }),
      actions: {
        start: async () => {},
        stop: async () => {},
        update: async () => {},
      },
    });

    app.moveAction(1);
    expect(app.state()).toMatchObject({
      screen: "main",
      selectedRow: 0,
      selectedAction: 1,
      pendingDetailsFor: null,
      error: null,
    });

    app.moveRow(1);
    expect(app.state()).toMatchObject({
      screen: "main",
      selectedRow: 1,
      selectedAction: 0,
      pendingDetailsFor: null,
      error: null,
    });

    app.moveRow(-1);
    expect(app.state()).toMatchObject({
      selectedRow: 0,
      selectedAction: 0,
    });

    app.moveRow(-1);
    expect(app.state()).toMatchObject({
      selectedRow: 2,
      selectedAction: 0,
    });
  });

  test("preserves the selected action when a row move resolves to the same row", () => {
    const app = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: true, pid: 1234 },
        snapshot: null,
        installedModules: [],
        updates: {
          session_vault: { kind: "module", version: "1.2.4" },
        },
      }),
      actions: {
        start: async () => {},
        stop: async () => {},
        update: async () => {},
      },
    });

    app.moveAction(1);
    expect(app.state()).toMatchObject({
      selectedRow: 0,
      selectedAction: 1,
    });

    app.moveRow(0);
    expect(app.state()).toMatchObject({
      selectedRow: 0,
      selectedAction: 1,
    });

    app.moveRow(3);
    expect(app.state()).toMatchObject({
      selectedRow: 0,
      selectedAction: 1,
    });
  });

  test("wraps actions within the current row", () => {
    const app = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: true, pid: 1234 },
        snapshot: null,
        installedModules: [],
        updates: {
          session_vault: { kind: "module", version: "1.2.4" },
        },
      }),
      actions: {
        start: async () => {},
        stop: async () => {},
        update: async () => {},
      },
    });

    app.moveAction(-1);
    expect(app.state().selectedAction).toBe(2);

    app.moveAction(1);
    expect(app.state().selectedAction).toBe(0);
  });

  test("dispatches start, stop, and update actions through injected handlers", async () => {
    const startCalls: string[] = [];
    const startApp = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: false, pid: null },
        snapshot: null,
        installedModules: [],
        updates: {},
      }),
      actions: {
        start: async () => startCalls.push("start"),
        stop: async () => startCalls.push("stop"),
        update: async (version) => startCalls.push(`update:${version}`),
      },
    });

    await startApp.activate();
    expect(startCalls).toEqual(["start"]);

    const stopCalls: string[] = [];
    const stopApp = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: true, pid: 1234 },
        snapshot: null,
        installedModules: [],
        updates: {
          session_vault: { kind: "module", version: "1.2.4" },
        },
      }),
      actions: {
        start: async () => stopCalls.push("start"),
        stop: async () => stopCalls.push("stop"),
        update: async (version) => stopCalls.push(`update:${version}`),
      },
    });

    await stopApp.activate();
    expect(stopCalls).toEqual(["stop"]);

    const updateCalls: string[] = [];
    const updateApp = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: true, pid: 1234 },
        snapshot: null,
        installedModules: [],
        updates: {
          session_vault: { kind: "module", version: "1.2.4" },
        },
      }),
      actions: {
        start: async () => updateCalls.push("start"),
        stop: async () => updateCalls.push("stop"),
        update: async (version) => updateCalls.push(`update:${version}`),
      },
    });

    updateApp.moveAction(1);
    await updateApp.activate();
    expect(updateCalls).toEqual(["update:1.2.4"]);
  });

  test("records a pending details target instead of rendering details", async () => {
    const app = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: false, pid: null },
        snapshot: null,
        installedModules: [],
        updates: {},
      }),
      actions: {
        start: async () => {},
        stop: async () => {},
        update: async () => {},
      },
    });

    app.moveAction(1);
    await app.activate();

    expect(app.state()).toMatchObject({
      screen: "details",
      pendingDetailsFor: "session_vault",
      selectedRow: 0,
      selectedAction: 1,
      error: null,
    });
  });

  test("captures action errors in controller state without throwing", async () => {
    const app = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: false, pid: null },
        snapshot: null,
        installedModules: [],
        updates: {},
      }),
      actions: {
        start: async () => {
          throw new Error("boom");
        },
        stop: async () => {},
        update: async () => {},
      },
    });

    await expect(app.activate()).resolves.toBeUndefined();
    expect(app.state().error).toBe("boom");
  });

  test("ignores disabled actions", async () => {
    const calls: string[] = [];
    const app = createTuiApp({
      model: {
        rows: [
          {
            id: "session_vault",
            label: "session_vault",
            availability: "live",
            statusLabel: "stopped",
            installedVersion: null,
            availableVersion: null,
            actions: [{ kind: "start", enabled: false }],
          },
        ],
        footerNote: "note",
      },
      actions: {
        start: async () => calls.push("start"),
        stop: async () => calls.push("stop"),
        update: async (version) => calls.push(`update:${version}`),
      },
    });

    await app.activate();

    expect(calls).toEqual([]);
    expect(app.state()).toMatchObject({
      screen: "main",
      pendingDetailsFor: null,
      error: null,
    });
  });
});
