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
          paths: MODEL_CLIENTS.map((name) => ({ name, message: modelClientMessage })),
          patterns: MODEL_CLIENTS.map((name) => ({
            group: [`${name}/*`],
            message: modelClientMessage,
          })),
        },
      ],
    },
  },
);
