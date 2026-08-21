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
    // Coverage output (test:coverage runs before lint in CI).
    "coverage/",
    "playwright-report/",
    // Vendored pdf.js runtime (native-imported, bypasses the bundler).
    "public/pdf.min.mjs",
    "public/pdf.worker.min.mjs",
  ]),
  {
    rules: {
      // A leading underscore is this repo's marker for "declared to satisfy a
      // signature, deliberately unused" - test doubles that must match a real
      // callback shape, destructured rest patterns, ignored catch bindings.
      // Without this the marker means nothing and the warning count never
      // reaches zero, which is what `--max-warnings 0` in `npm run lint`
      // requires.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
]);

export default eslintConfig;
