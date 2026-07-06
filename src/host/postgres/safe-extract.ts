// Pre-extraction audit for downloaded archives (zip-slip / tar-slip / symlink
// guard). A tampered pgvector tarball or zonky jar could carry a member that
// writes OUTSIDE the destination — an absolute path, a `..` traversal, or a
// symlink/hardlink pointing at a host file the fortress can then overwrite via a
// follow-up member. `tar`/`unzip` extract such members faithfully, so we LIST
// the archive first (`tar -t…`) and refuse to extract if any member is unsafe.
//
// The binaries are invoked by absolute path (resolved once via Bun.which) so a
// hostile $PATH can't shadow `tar`/`unzip`; if resolution fails we fall back to
// the bare name (dev machines where which() misses but the tool is on PATH).

import type { Spawner } from "./spawn";

const binCache = new Map<string, string>();

/** Absolute path to a system binary, resolved once and memoized. Falls back to
 *  the bare name when `Bun.which` can't locate it. */
export function resolveBin(name: string): string {
  const cached = binCache.get(name);
  if (cached) return cached;
  const resolved = Bun.which(name) ?? name;
  binCache.set(name, resolved);
  return resolved;
}

// Cap the captured `tar -t…` listing — a tampered archive with billions of
// members would otherwise stream an unbounded listing into memory. A real
// pgvector/zonky listing is a few KB; 16 MiB is orders of magnitude of headroom.
const MAX_LISTING_BYTES = 16 * 1024 * 1024;

async function capture(spawner: Spawner, cmd: string[]): Promise<string> {
  const { code, stdout, stderr } = await spawner.run(cmd, { maxStdoutBytes: MAX_LISTING_BYTES });
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${stderr.trim()}`);
  return stdout ?? "";
}

/** Throw if a tar member path escapes the destination (absolute or contains a
 *  `..` segment). A leading `./` (how `tar -C . …` packs entries) is stripped. */
function assertSafeMemberPath(name: string, tarPath: string): void {
  const p = name.replace(/^\.\/+/, "");
  if (name.startsWith("/") || p.startsWith("/")) {
    throw new Error(`unsafe tar member (absolute path) in ${tarPath}: ${name}`);
  }
  if (p.split("/").some((seg) => seg === "..")) {
    throw new Error(`unsafe tar member (parent-dir escape) in ${tarPath}: ${name}`);
  }
}

/**
 * Audit a tar archive BEFORE extraction: reject any symlink/hardlink member,
 * absolute path, or `..` traversal. `flags` carries the compression selector
 * (`"z"` for .tar.gz, `"J"` for .txz) so the listing matches the later extract.
 * A read-only two-pass listing (`-t` for clean names, `-tv` for member types).
 */
export async function assertSafeTar(
  spawner: Spawner,
  tarPath: string,
  flags: string,
): Promise<void> {
  const tar = resolveBin("tar");

  // Pass 1: clean member names (one per line) for the path-escape checks.
  const names = await capture(spawner, [tar, `-t${flags}f`, tarPath]);
  let memberCount = 0;
  for (const line of names.split("\n")) {
    const name = line.trim();
    if (name.length === 0) continue;
    assertSafeMemberPath(name, tarPath);
    memberCount += 1;
  }
  // Fail CLOSED on an empty listing: zero members means the audit inspected
  // nothing, so extracting would be unaudited. A legitimate archive always lists
  // at least one member (and an empty stdout is how a mis-behaving spawner would
  // silently defeat the guard), so reject rather than fall through.
  if (memberCount === 0) {
    throw new Error(`refusing to extract ${tarPath}: archive listing is empty (unaudited)`);
  }

  // Pass 2: verbose listing for type detection. The first character of each line
  // is the member's type across GNU and BSD tar — reject anything that isn't a
  // regular file / directory: `l` symlink, `h` hardlink, `b`/`c` device, `p` FIFO,
  // `s` socket (a device/FIFO member is never part of a code artifact and could be
  // abused). The ` -> ` / ` link to ` markers are a belt-and-suspenders backstop.
  const verbose = await capture(spawner, [tar, `-tv${flags}f`, tarPath]);
  for (const line of verbose.split("\n")) {
    if (line.trim().length === 0) continue;
    const type = line[0];
    if (
      type === "l" ||
      type === "h" ||
      type === "b" ||
      type === "c" ||
      type === "p" ||
      type === "s" ||
      line.includes(" -> ") ||
      line.includes(" link to ")
    ) {
      throw new Error(`unsafe tar member (symlink/hardlink/device/fifo) in ${tarPath}: ${line.trim()}`);
    }
  }
}
