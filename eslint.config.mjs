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
