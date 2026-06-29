// Identity reconciliation for the ingestion path. The capability token carries
// the cloud's external ids (org/repo/project/user/device); the bundled hx
// dimension tables key on those external ids, so each commit upserts the row
// and returns its local uuid for the session FKs. All run inside the commit
// transaction (HxTx).

import type { HxTx } from "../host/postgres/db";
import { hxDevices, hxModels, hxOrgs, hxProjects, hxRepos, hxUsers } from "../host/postgres/schema";
import { priceForModel } from "./pricing";

export async function upsertUser(tx: HxTx, externalId: string, now: string): Promise<string> {
  const [row] = await tx
    .insert(hxUsers)
    .values({ externalId })
    .onConflictDoUpdate({ target: hxUsers.externalId, set: { updatedAt: now } })
    .returning({ id: hxUsers.id });
  return row.id;
}

export async function upsertOrg(tx: HxTx, externalId: string, now: string): Promise<string> {
  const [row] = await tx
    .insert(hxOrgs)
    .values({ externalId })
    .onConflictDoUpdate({ target: hxOrgs.externalId, set: { updatedAt: now } })
    .returning({ id: hxOrgs.id });
  return row.id;
}

export async function upsertProject(
  tx: HxTx,
  orgId: string,
  externalId: string,
  now: string,
): Promise<string> {
  const [row] = await tx
    .insert(hxProjects)
    .values({ orgId, externalId })
    .onConflictDoUpdate({ target: [hxProjects.orgId, hxProjects.externalId], set: { updatedAt: now } })
    .returning({ id: hxProjects.id });
  return row.id;
}

export async function upsertRepo(
  tx: HxTx,
  slug: string,
  projectId: string | null,
  now: string,
): Promise<string> {
  const [row] = await tx
    .insert(hxRepos)
    .values({ slug: slug.toLowerCase(), projectId })
    .onConflictDoUpdate({ target: hxRepos.slug, set: { projectId, updatedAt: now } })
    .returning({ id: hxRepos.id });
  return row.id;
}

/** Upsert the device and stamp it as having just uploaded (genuine contact +
 *  data), per the spec: last_upload_at on every commit, last_seen_at on any
 *  authed contact. */
export async function upsertDevice(
  tx: HxTx,
  userId: string,
  deviceId: string,
  now: string,
): Promise<string> {
  const [row] = await tx
    .insert(hxDevices)
    .values({ userId, deviceId, lastUploadAt: now, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [hxDevices.userId, hxDevices.deviceId],
      set: { lastUploadAt: now, lastSeenAt: now, updatedAt: now },
    })
    .returning({ id: hxDevices.id });
  return row.id;
}

/** Upsert a model dimension, seeding the per-Mtok columns from the shared price
 *  map so the analysis layer can price tokens without re-deriving them. */
export async function upsertModel(tx: HxTx, modelId: string, now: string): Promise<string> {
  const price = priceForModel(modelId);
  const pricing = price
    ? {
        inputPerMtok: price.inputPerMtok,
        outputPerMtok: price.outputPerMtok,
        cacheReadPerMtok: price.cacheReadPerMtok,
        cacheWritePerMtok: price.cacheWritePerMtok,
      }
    : {};
  const [row] = await tx
    .insert(hxModels)
    .values({ modelId, ...pricing })
    .onConflictDoUpdate({ target: hxModels.modelId, set: { ...pricing, updatedAt: now } })
    .returning({ id: hxModels.id });
  return row.id;
}
