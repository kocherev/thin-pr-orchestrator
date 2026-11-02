import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: fileURLToPath(new URL("./wrangler.test.jsonc", import.meta.url)) },
      miniflare: {
        bindings: {
          GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
          GITHUB_APP_CLIENT_ID: "Iv23liTest",
          GITHUB_APP_PRIVATE_KEY: privateKey,
          ANTHROPIC_API_KEY: "test-anthropic-key",
        },
      },
    }),
  ],
  test: {
    name: "worker",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["test/**/*.test.ts"],
  },
});
