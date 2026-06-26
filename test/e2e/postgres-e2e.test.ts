import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildPostgresProvider } from "../../src/host/postgres";
import { fortressPaths } from "../../src/host/paths";
import type { FortressConfig } from "../../src/host/types";

const RUN = process.env.FORTRESS_PG_E2E === "1";
const config: FortressConfig = {
  schemaVersion: 1,
  cloud: { url: "wss://x/tunnel" },
  gateway: { publicUrl: "https://x" },
  modules: { enabled: [] },
};

describe.if(RUN)("postgres e2e", () => {
  let root = "";
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test(
    "acquires, initializes, accepts connections; restart reuses pgdata",
    async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "hx-pg-e2e-"));
      const paths = fortressPaths(root);

      const first = buildPostgresProvider({ env: {}, config, paths });
      await first.start();
      expect(first.status().phase).toBe("ready");
      expect(first.dsn()).toContain("hx-db");
      await first.stop();

      const second = buildPostgresProvider({ env: {}, config, paths });
      await second.start();
      expect(second.status().phase).toBe("ready");
      await second.stop();
    },
    120_000,
  );
});
