import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
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
