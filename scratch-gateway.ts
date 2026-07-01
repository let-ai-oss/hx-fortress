import { readFileSync } from "node:fs";
import { startGatewayServer } from "./src/gateway/server";
import { createHxDb } from "./src/host/postgres/db";
import { S3Store } from "./src/modules/session-vault/store/s3-store";
import { createOpenAIEmbedder } from "./src/modules/embed-worker";

const DSN = "postgres://forge:forge@localhost:5499/hx-db";
const DEFORG = "d3fa1735-0000-4000-8000-000000000001";
const DESK = "/mnt/c/Users/Mr_Fi/Desktop";
const s3 = readFileSync(`${DESK}/s3.txt`, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const OPENAI = readFileSync(`${DESK}/openai.txt`, "utf8").trim();
const KP = JSON.parse(readFileSync("/home/feuer/let-forge/.claude/worktrees/mc-2432-hx-fortress/scratch/fortress-kp.json", "utf8"));

const store = new S3Store({ region: "us-east-2", bucketName: "sm-s3-yaspafortres-prod", credentials: { accessKeyId: s3[0], secretAccessKey: s3[1], sessionToken: s3[2] } });
const db = createHxDb(DSN);
const embedder = createOpenAIEmbedder({ apiKey: OPENAI, model: "text-embedding-3-large", dimensions: 1024 });

const handle = startGatewayServer({
  port: 8899,
  logger: { info() {}, error(m: string, f?: Record<string, unknown>) { console.error("[gw]", m, f ? JSON.stringify(f).slice(0, 240) : ""); } },
  signingKey: async () => KP.x as string,
  store: () => store,
  postgresReady: () => true,
  db: () => db,
  embedder,
  ownOrgId: async () => DEFORG,
});
console.log(`FORTRESS-GATEWAY-READY port=${handle.port} store=S3 embedder=${embedder.model}`);
await new Promise(() => {});
