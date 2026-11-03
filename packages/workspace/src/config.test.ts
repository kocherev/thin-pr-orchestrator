import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyPath, createMemoryWorkspace, loadRepoConfig } from "./index.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoConfig", () => {
  it("uses the defaults when .thin-pr.yml is missing", () => {
    expect(loadRepoConfig(repo())).toEqual({
      checks: { typecheck: "pnpm exec tsc --noEmit", test: "pnpm exec vitest run" },
      budget: {},
      paths: {
        allow: ["src/**", "test/**", "examples/**", "README.md", "docs/**"],
        deny: [".github/**", "**/.env*", "pnpm-lock.yaml", "package-lock.json"],
      },
    });
  });

  it("keeps the defaults a file does not override", () => {
    const config = loadRepoConfig(repo("install: pnpm install --frozen-lockfile\nchecks:\n  test: vitest run\nbudget:\n  max_lines: 40\nspend_usd: 2.5\n"));
    expect(config.install).toBe("pnpm install --frozen-lockfile");
    expect(config.checks).toEqual({ typecheck: "pnpm exec tsc --noEmit", test: "vitest run" });
    // A budget override sets only the fields it names. The rest come from the template.
    expect(config.budget).toEqual({ max_lines: 40 });
    expect(config.spend_usd).toBe(2.5);
    expect(config.paths.deny).toContain(".github/**");
  });

  it("rejects a bad value with its path", () => {
    expect(() => loadRepoConfig(repo("budget:\n  max_files: 0\n"))).toThrow(".thin-pr.yml invalid at budget.max_files");
    expect(() => loadRepoConfig(repo("spend_usd: 0\n"))).toThrow(".thin-pr.yml invalid at spend_usd");
    expect(() => loadRepoConfig(repo("checks:\n  lint: eslint .\n"))).toThrow(".thin-pr.yml invalid at checks");
    expect(() => loadRepoConfig(repo("budget: [\n"))).toThrow(".thin-pr.yml is not valid YAML");
  });
});

describe("classifyPath", () => {
  const { paths } = loadRepoConfig(repo());

  it("allows matching paths and lets a deny match win", () => {
    expect(classifyPath(paths, "src/counter.ts")).toBe("allowed");
    expect(classifyPath(paths, "docs/guide/setup.md")).toBe("allowed");
    expect(classifyPath(paths, ".github/workflows/ci.yml")).toBe("denied");
    expect(classifyPath(paths, "src/.env.local")).toBe("denied");
    expect(classifyPath(paths, "pnpm-lock.yaml")).toBe("denied");
    expect(classifyPath(paths, "package.json")).toBe("not-allowed");
    expect(classifyPath(paths, "README.md.bak")).toBe("not-allowed");
  });
});

describe("createMemoryWorkspace", () => {
  it("applies the same file rules and returns the check outcome it was given", async () => {
    const workspace = createMemoryWorkspace(
      { "src/counter.ts": "export const count = 1;\n" },
      { typecheck: { exitCode: 0, logTail: "" }, test: { exitCode: 1, logTail: "1 failed" } },
    );
    await workspace.replace("src/counter.ts", "1", "2");
    await workspace.createFile("src/reset.ts", "export const reset = 0;\n");
    await expect(workspace.createFile(".github/ci.yml", "")).rejects.toThrow("matches a denied path");

    expect(await workspace.runCheck("test")).toMatchObject({ name: "test", exitCode: 1, logTail: "1 failed" });
    expect(await workspace.diff()).toEqual({
      files: [
        { path: "src/counter.ts", added: 1, removed: 1 },
        { path: "src/reset.ts", added: 1, removed: 0 },
      ],
      meaningful: true,
      patch: [
        "--- a/src/counter.ts",
        "+++ b/src/counter.ts",
        "@@ -1,1 +1,1 @@",
        "-export const count = 1;",
        "+export const count = 2;",
        "--- /dev/null",
        "+++ b/src/reset.ts",
        "@@ -1,0 +1,1 @@",
        "+export const reset = 0;",
        "",
      ].join("\n"),
    });
  });
});

function repo(config?: string): string {
  const directory = mkdtempSync(join(tmpdir(), "thin-pr-config-"));
  directories.push(directory);
  if (config !== undefined) {
    writeFileSync(join(directory, ".thin-pr.yml"), config);
  }
  return directory;
}
