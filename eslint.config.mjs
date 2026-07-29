import js from "@eslint/js";
import tseslint from "typescript-eslint";
import nextPlugin from "eslint-config-next";
import globals from "globals";

const nextConfig = nextPlugin.map((entry) =>
  entry.files
    ? { ...entry, files: entry.files.map((glob) => `apps/web/${glob}`) }
    : entry,
);

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/build/**",
      "**/out/**",
      "**/*.tsbuildinfo",
      "context-graph/graph.json",
      "context-graph/graph.mmd",
      "design/handoff/**",
      // Agent worktrees are full checkouts of this repo. Linting them lints duplicate copies of
      // every source file, and the duplicates trip rules scoped by path (the Scope-cast
      // no-restricted-syntax exemption below is keyed to packages/core/src/*, so the copies fail
      // it). Each worktree runs its own gate against its own branch.
      ".claude/worktrees/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...nextConfig,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // ADR 0002: Scope and Visible<T> are access-control witnesses, not plain brands. The only
    // legitimate construction sites are mintScope (scope-internal.ts) and
    // assertVisible/assertSourceVisible (index.ts) — everywhere else, a cast is a bypass of the
    // scope check those functions perform. This is what makes "skipping the check is a type
    // error" true rather than aspirational; without it, `as Scope` / `as Visible<T>` compiles
    // anywhere with no import and no hook to catch it.
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["packages/core/src/index.ts", "packages/core/src/scope-internal.ts", "packages/core/src/untrusted.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression[typeAnnotation.typeName.name='Scope']",
          message:
            "Do not cast to Scope. Take one as a parameter, minted upstream by mintScope (@strata/core/scope-internal, packages/auth only).",
        },
        {
          selector: "TSAsExpression[typeAnnotation.typeName.name='Untrusted']",
          message:
            "Do not cast to Untrusted<T>. Obtain it from normalizeIngested/asUntrusted (@strata/core) - ADR 0005.",
        },
        {
          selector: "TSAsExpression[typeAnnotation.typeName.name='Visible']",
          message:
            "Do not cast to Visible<T>. Obtain it from assertVisible/assertSourceVisible (@strata/core) — that call is the scope re-check.",
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    // Workflow DSL scripts: executed by the orchestrator, which injects
    // `args`/`phase`/`agent`/`log`/`pipeline`/`parallel` into scope — not real Node/browser globals.
    files: [".claude/workflows/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: {
        args: "readonly",
        phase: "readonly",
        agent: "readonly",
        log: "readonly",
        pipeline: "readonly",
        parallel: "readonly",
      },
    },
  },
);
