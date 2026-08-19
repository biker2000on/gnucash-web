import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local git worktrees and agent scratch checkouts are full repo copies
    // (each with its own .next/ and node_modules/). Trailing-slash form so
    // ESLint skips the directories outright instead of walking them.
    ".worktrees/",
    ".claude/",
    ".polly/",
  ]),
]);

export default eslintConfig;
