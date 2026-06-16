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
    expect(workflow).toContain('> "${out_path}.sha256"');
    expect(workflow).toContain('gzip -9 -f "$out_path"');
    expect(workflow).toContain("dist/hx-fortress-version");
  });

  test("publishes rolling releases and immutable releases on manual dispatch", () => {
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain('gh release create "$tag" dist/hx-fortress-*');
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
  });
});
