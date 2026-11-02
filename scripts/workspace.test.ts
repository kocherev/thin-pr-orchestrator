import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanDirectory } from "./check-core-boundary.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("workspace", () => {
  it("resolves the root scripts through pnpm", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const listed = execFileSync("pnpm", ["run"], {
      cwd: root,
      encoding: "utf8",
    });

    for (const name of ["lint", "typecheck", "test", "build", "eval"]) {
      expect(manifest.scripts[name]).toBeTruthy();
      expect(listed).toContain(name);
    }
  });

  it("documents the replay eval command", () => {
    const text = readFileSync(join(root, "evals", "README.md"), "utf8");
    expect(text.toLowerCase()).toContain("replay");
    expect(text).toContain("pnpm eval");
    expect(text).toContain("evals/sample-repo");
    expect(text).toContain("baseline");
  });

  it("finds no model client import under packages/core", () => {
    expect(scanDirectory(join(root, "packages", "core"))).toEqual([]);
  });
});
