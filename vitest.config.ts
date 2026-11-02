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
          // Tests spawn git, pnpm, tsc and vitest. The slowest of them took 33 s on a loaded machine.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      "packages/app/vitest.config.ts",
    ],
  },
});
