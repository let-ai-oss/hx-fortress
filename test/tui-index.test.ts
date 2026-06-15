import { describe, expect, test } from "bun:test";

import { runFortressTui } from "../src/tui";
import type { TuiApp } from "../src/tui/app";
import type { ServiceInstallOptions, ServiceManager, ServiceState } from "../src/service";

describe("runFortressTui", () => {
  test("fails clearly when service state cannot be read", async () => {
    const renderCalls: TuiApp[] = [];

    await expect(
      runFortressTui(
        {},
        {
          serviceManager: {
            state: async () => {
              throw new Error("service boom");
            },
          },
          runTerminalRenderer: async (app) => {
            renderCalls.push(app);
            return 0;
          },
        },
      ),
    ).rejects.toThrow("service boom");

    expect(renderCalls).toHaveLength(0);
  });

  test("surfaces malformed status snapshot errors", async () => {
    const renderCalls: TuiApp[] = [];

    await expect(
      runFortressTui(
        {},
        {
          serviceManager: {
            state: async () => ({ loaded: false, pid: null }),
          },
          statusReader: {
            read: async () => {
              throw new Error("Invalid Fortress status: malformed JSON");
            },
          },
          runTerminalRenderer: async (app) => {
            renderCalls.push(app);
            return 0;
          },
        },
      ),
    ).rejects.toThrow("Invalid Fortress status: malformed JSON");

    expect(renderCalls).toHaveLength(0);
  });

  test("keeps rendering when snapshot is missing and version metadata fails", async () => {
    let renderedApp: TuiApp | undefined;

    const exitCode = await runFortressTui(
      {},
      {
        serviceManager: {
          state: async () => ({ loaded: false, pid: null }),
        },
        statusReader: {
          read: async () => null,
        },
        inventoryStore: {
          load: async () => {
            throw new Error("inventory boom");
          },
        },
        updateStatusProvider: {
          load: async () => {
            throw new Error("updates boom");
          },
        },
        runTerminalRenderer: async (app) => {
          renderedApp = app;
          return 0;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(renderedApp).toBeDefined();
    expect(renderedApp?.model().rows[0]).toMatchObject({
      id: "session_vault",
      installedVersion: null,
      availableVersion: null,
      statusLabel: "stopped",
    });
  });

  test("wires the start action through the lifecycle helper", async () => {
    let renderedApp: TuiApp | undefined;
    const manager = fakeManager([
      { loaded: false, pid: null },
      { loaded: false, pid: null },
      { loaded: true, pid: 4321 },
    ]);
    const lines: string[] = [];

    await runFortressTui(
      {},
      {
        serviceManager: manager,
        statusReader: {
          read: async () => null,
        },
        runTerminalRenderer: async (app) => {
          renderedApp = app;
          return 0;
        },
        executablePath: "/tmp/hx-fortress-bin",
        paths: {
          log: "/tmp/fortress.log",
          serviceLog: "/tmp/service.log",
        },
        writeLine: (line) => lines.push(line),
      },
    );

    await renderedApp?.activate();

    expect(manager.installCalls).toEqual([
      {
        executablePath: "/tmp/hx-fortress-bin",
        serviceLogPath: "/tmp/service.log",
      },
    ]);
    expect(lines).toEqual([
      "Fortress started (launchd, pid 4321).",
      "logs: /tmp/fortress.log",
      "status: hx-fortress status",
    ]);
  });

  test("wires the stop action through the lifecycle helper", async () => {
    let renderedApp: TuiApp | undefined;
    const manager = fakeManager([{ loaded: true, pid: 4321 }], true);
    const lines: string[] = [];

    await runFortressTui(
      {},
      {
        serviceManager: manager,
        statusReader: {
          read: async () => null,
        },
        runTerminalRenderer: async (app) => {
          renderedApp = app;
          return 0;
        },
        writeLine: (line) => lines.push(line),
      },
    );

    await renderedApp?.activate();

    expect(manager.stopCalls).toBe(1);
    expect(lines).toEqual([
      "Fortress stopped (launchd). Run `hx-fortress start` to resume.",
    ]);
  });
});

interface FakeManager extends ServiceManager {
  installCalls: ServiceInstallOptions[];
  stopCalls: number;
}

function fakeManager(
  states: ServiceState[],
  wasRunning = false,
): FakeManager {
  return {
    name: "launchd",
    installCalls: [],
    stopCalls: 0,
    async install(options) {
      this.installCalls.push(options);
    },
    async stop() {
      this.stopCalls += 1;
      return { wasRunning };
    },
    async state() {
      return states.shift() ?? { loaded: false, pid: null };
    },
  };
}
