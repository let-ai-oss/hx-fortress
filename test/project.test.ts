import { describe, expect, test } from "bun:test";

import packageJson from "../package.json";

describe("project skeleton", () => {
  test("uses the hx-fortress package identity", () => {
    expect(packageJson.name).toBe("hx-fortress");
    expect(packageJson.private).toBe(true);
    expect(packageJson.type).toBe("module");
    expect(packageJson.packageManager).toBe("bun@1.3.14");
    expect(packageJson.devDependencies).toEqual({
      "@eslint/js": "10.0.1",
      "@types/bun": "1.3.14",
      eslint: "10.5.0",
      typescript: "6.0.3",
      "typescript-eslint": "8.61.0",
    });
  });
});
