import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

export default tseslint.config(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  // Security-aware linting (OSS Readiness Plan, Part 4.3). Start at recommended;
  // ratchet warn->error once existing findings are burned down (Part 2, §2.4).
  security.configs.recommended,
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@forge/session-store", "@forge/session-store/*"],
              message: "Import the wire contract through src/protocol only.",
            },
            {
              group: ["@forge/hx-client", "@forge/hx-client/*"],
              message: "Import the wire contract through src/protocol only.",
            },
          ],
        },
      ],
    },
  },
);
