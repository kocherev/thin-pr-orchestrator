import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts", "packages/app/runner/*.test.ts", "scripts/**/*.test.ts", "apps/console/lib/**/*.test.ts"],
          execArgv: ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"],
        },
      },
      "packages/app/vitest.config.ts",
    ],
  },
});
