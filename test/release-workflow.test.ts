import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/release.yml", import.meta.url);
const workflow = await Bun.file(workflowPath).text();

describe("release workflow", () => {
  test("builds the four supported hx-fortress binaries with checksums and gzip assets", () => {
    for (const target of [
      "bun-darwin-arm64",
      "bun-darwin-x64",
      "bun-linux-arm64",
      "bun-linux-x64",
    ]) {
      expect(workflow).toContain(target);
    }

    expect(workflow).toContain("hx-fortress-${target#bun-}");
    expect(workflow).toContain("./src/cli.ts");
    // x64 builds must use the -baseline runtime so they run on CPUs without
    // AVX2 (MC-2366); the build target is derived from $target at runtime.
    expect(workflow).toContain('*-x64) build_target="${target}-baseline" ;;');
    expect(workflow).toContain('--target="$build_target"');
    expect(workflow).toContain('> "${out_path}.sha256"');
    expect(workflow).toContain('gzip -9 -f "$out_path"');
    expect(workflow).toContain("dist/hx-fortress-version");
  });

  test("publishes rolling releases and immutable releases on manual dispatch", () => {
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain('gh release create "$tag" dist/hx-fortress-*');
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
  });

  test("signs artifacts and attests build provenance (supply-chain)", () => {
    // Ed25519 detached signatures over the binaries + pgvector tarball…
    expect(workflow).toContain("scripts/sign-artifact.ts");
    expect(workflow).toContain("FORTRESS_SIGNING_KEY");
    // …plus GitHub build-provenance attestation…
    expect(workflow).toContain("attest-build-provenance");
    expect(workflow).toContain("id-token: write");
    // …while keeping the same-origin .sha256 integrity sidecars.
    expect(workflow).toContain('> "${out_path}.sha256"');
  });

  test("publishes GHCR tags and dispatches let-forge after a successful image push", () => {
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("docker/setup-buildx-action");
    expect(workflow).toContain("docker/metadata-action");
    expect(workflow).toContain("docker/build-push-action");
    expect(workflow).toContain("ghcr.io/let-ai-oss/hx-fortress");
    expect(workflow).toContain("type=raw,value=latest");
    expect(workflow).toContain("type=raw,value=${{ steps.version.outputs.value }}");
    expect(workflow).toContain("type=raw,value=sha-");
    expect(workflow).toContain("LET_FORGE_REPO_DISPATCH_TOKEN");
    expect(workflow).toContain("event-type: hx-fortress-image-published");
  });
});
