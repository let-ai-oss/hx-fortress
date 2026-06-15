import { describe, expect, test } from "bun:test";

import { runFortressTui } from "../src/tui";
import type { TuiApp } from "../src/tui/app";

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
});
