import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { runMigrations } from "../../src/host/postgres/migrate";
import { migrations } from "../../src/host/postgres/migrations/manifest";
import { makeMigrationExec, startCluster, type Cluster } from "./_cluster";

// Gated like the other embedded-cluster e2e: opt in with FORTRESS_PG_E2E=1
// (first run downloads + extracts the zonky binaries).
const RUN = process.env.FORTRESS_PG_E2E === "1";

describe.if(RUN)("hx schema migrations", () => {
  let cluster: Cluster;
  beforeAll(async () => {
    cluster = await startCluster();
    await runMigrations(makeMigrationExec(cluster.dsn), migrations);
  }, 180_000);
  afterAll(async () => {
    if (cluster) await cluster.stop();
  });

  test("0000 installs the core extensions", async () => {
    const db = makeMigrationExec(cluster.dsn);
    const rows = await db.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','pg_trgm','btree_gin')",
    );
    const names = rows.map((r) => r.extname).sort();
    expect(names).toEqual(["btree_gin", "pg_trgm", "pgcrypto"]);
  });

  test("migration run is idempotent", async () => {
    const applied = await runMigrations(makeMigrationExec(cluster.dsn), migrations);
    expect(applied).toEqual([]);
  });

  test("0001 creates all dimension tables in the hx schema", async () => {
    const db = makeMigrationExec(cluster.dsn);
    const rows = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'hx'",
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ["users", "orgs", "projects", "repos", "devices", "models"]) {
      expect(names).toContain(t);
    }
  });

  test("project FK rejects an org_id with no matching org", async () => {
    const db = makeMigrationExec(cluster.dsn);
    let threw = false;
    try {
      await db.exec(
        "INSERT INTO hx.projects (org_id, external_id) VALUES (gen_random_uuid(), 'p1')",
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("session natural key (user, family, session_id) is unique", async () => {
    const db = makeMigrationExec(cluster.dsn);
    await db.exec(
      "INSERT INTO hx.users (id, external_id) VALUES ('11111111-1111-7111-8111-111111111111','u-sess')",
    );
    await db.exec(
      "INSERT INTO hx.sessions (user_id, family, session_id) VALUES ('11111111-1111-7111-8111-111111111111','claude-cli','s1')",
    );
    let threw = false;
    try {
      await db.exec(
        "INSERT INTO hx.sessions (user_id, family, session_id) VALUES ('11111111-1111-7111-8111-111111111111','claude-cli','s1')",
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("session rollup counters default to 0", async () => {
    const db = makeMigrationExec(cluster.dsn);
    const rows = await db.query<{ event_count: number; bytes_uploaded: number }>(
      "SELECT event_count, bytes_uploaded FROM hx.sessions WHERE session_id = 's1'",
    );
    expect(rows[0].event_count).toBe(0);
    expect(Number(rows[0].bytes_uploaded)).toBe(0);
  });
});
