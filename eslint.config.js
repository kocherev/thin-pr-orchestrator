import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const MODEL_CLIENTS = [
  "openai",
  "@anthropic-ai/sdk",
  "@ai-sdk/anthropic",
  "@ai-sdk/openai",
  "@ai-sdk/google",
  "@google/generative-ai",
  "ai",
];

const modelClientMessage = "Model clients are not allowed in packages/core.";

const GITHUB_CLIENTS = ["@octokit/rest", "@actions/core", "@actions/github"];

const githubClientMessage = "GitHub clients belong in packages/github.";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...MODEL_CLIENTS.map((name) => ({ name, message: modelClientMessage })),
            ...GITHUB_CLIENTS.map((name) => ({ name, message: githubClientMessage })),
          ],
          patterns: [
            ...MODEL_CLIENTS.map((name) => ({
              group: [`${name}/*`],
              message: modelClientMessage,
            })),
            ...GITHUB_CLIENTS.map((name) => ({
              group: [`${name}/*`],
              message: githubClientMessage,
            })),
          ],
        },
      ],
    },
  },
  {
    files: ["packages/specialists/**/*.ts", "packages/gate/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: GITHUB_CLIENTS.map((name) => ({ name, message: githubClientMessage })),
          patterns: GITHUB_CLIENTS.map((name) => ({
            group: [`${name}/*`],
            message: githubClientMessage,
          })),
        },
      ],
    },
  },
);
