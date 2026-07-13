import { describe, expect, test } from "bun:test";

import packageJson from "../package.json";
import * as host from "../src/host";

describe("project skeleton", () => {
  test("uses the hx-fortress package identity", () => {
    expect(packageJson.name).toBe("hx-fortress");
    expect(packageJson.private).toBe(true);
    expect(packageJson.type).toBe("module");
    expect(packageJson.bin).toEqual({
      "hx-fortress": "./src/cli.ts",
    });
    expect(packageJson.packageManager).toBe("bun@1.3.14");
    expect(packageJson.devDependencies).toEqual({
      "@eslint/js": "10.0.1",
      "@types/bun": "1.3.14",
      "drizzle-kit": "^0.31.10",
      eslint: "10.5.0",
      "eslint-plugin-security": "4.0.1",
      typescript: "6.0.3",
      "typescript-eslint": "8.61.0",
    });
  });

  test("defines local dev and build scripts", () => {
    expect(packageJson.scripts).toMatchObject({
      dev: "bun --watch src/cli.ts",
      build: "mkdir -p ./dist && bun build ./src/cli.ts --compile --outfile ./dist/hx-fortress",
    });
  });

  test("exposes the host lifecycle through one public boundary", () => {
    expect(host).toMatchObject({
      FileConfigStore: expect.any(Function),
      FileStatusStore: expect.any(Function),
      HostRuntime: expect.any(Function),
      fortressPaths: expect.any(Function),
      runFortressHost: expect.any(Function),
      runHost: expect.any(Function),
    });
  });
});
