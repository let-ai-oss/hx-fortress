import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import type { ZonkyClassifier } from "./classifier";
import { ProgressBar } from "../../progress";

export function zonkyJarUrl(
  binariesUrl: string,
  classifier: ZonkyClassifier,
  version: string,
): string {
  const base = binariesUrl.replace(/\/+$/, "");
  const artifact = `embedded-postgres-binaries-${classifier}`;
  return `${base}/io/zonky/test/postgres/${artifact}/${version}/${artifact}-${version}.jar`;
}

export interface AcquireDeps {
  fetchImpl: typeof fetch;
  extract: (jarPath: string, destDir: string) => Promise<void>;
  cacheDir: string;
  versionDir: string;
  classifier: ZonkyClassifier;
  version: string;
  binariesUrl: string;
}

export async function acquireBinaries(deps: AcquireDeps): Promise<string> {
  const binDir = path.join(deps.versionDir, "bin");
  const sentinel = path.join(deps.versionDir, ".ready");
  if (existsSync(sentinel)) return binDir;

  const url = zonkyJarUrl(deps.binariesUrl, deps.classifier, deps.version);
  // MC-2464: show the same dim-label + blue-bar + percent indicator the curl
  // installer and `hx-fortress update` use while the Postgres runtime downloads.
  const bar = new ProgressBar();
  bar.status("Downloading the Postgres runtime…");
  const jarBytes = await fetchBytes(deps.fetchImpl, url, (received, total) => {
    if (total > 0) bar.draw((received / total) * 100, "Downloading");
  });
  bar.end();
  const expected = await fetchExpectedSha(deps.fetchImpl, `${url}.sha256`);
  const actual = createHash("sha256").update(jarBytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Postgres binary checksum mismatch for ${url}`);
  }

  await mkdir(deps.cacheDir, { recursive: true });
  const jarPath = path.join(deps.cacheDir, `${deps.classifier}-${deps.version}.jar`);
  await writeFile(jarPath, jarBytes);

  await rm(deps.versionDir, { recursive: true, force: true });
  await mkdir(deps.versionDir, { recursive: true });
  await deps.extract(jarPath, deps.versionDir);
  await writeFile(sentinel, `${deps.version}\n`);
  return binDir;
}

async function fetchBytes(
  fetchImpl: typeof fetch,
  url: string,
  onProgress?: (received: number, total: number) => void,
): Promise<Uint8Array> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Postgres binary download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  onProgress?.(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      chunks.push(value);
      received += value.length;
      onProgress?.(received, total);
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function fetchExpectedSha(fetchImpl: typeof fetch, url: string): Promise<string> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Postgres checksum download failed (${res.status}) for ${url}`);
  const text = await res.text();
  const token = text.trim().split(/\s+/)[0] ?? "";
  return token.toLowerCase();
}
