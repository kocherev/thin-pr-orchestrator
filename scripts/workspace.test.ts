import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packageId as coreId, ping } from "@thin-pr/core";
import { packageId as gateId, readiness } from "@thin-pr/gate";
import { packageId as githubId, entrypoint } from "@thin-pr/github";
import { listSpecialists, packageId as specialistsId } from "@thin-pr/specialists";
import { scanDirectory } from "./check-core-boundary.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("workspace", () => {
  it("resolves each package export", () => {
    expect(coreId).toBe("@thin-pr/core");
    expect(ping()).toBe("pong");
    expect(specialistsId).toBe("@thin-pr/specialists");
    expect(listSpecialists().map((specialist) => specialist.id)).toEqual([
      "planner",
      "implementer",
      "tester",
      "reviewer",
      "pr-writer",
    ]);
    expect(gateId).toBe("@thin-pr/gate");
    expect(readiness()).toBe("unconfigured");
    expect(githubId).toBe("@thin-pr/github");
    expect(entrypoint()).toBe("not-wired");
  });

  it("resolves the root scripts through pnpm", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const listed = execFileSync("pnpm", ["run"], {
      cwd: root,
      encoding: "utf8",
    });

    for (const name of ["lint", "typecheck", "test", "build"]) {
      expect(manifest.scripts[name]).toBeTruthy();
      expect(listed).toContain(name);
    }
  });

  it("keeps workflow templates unloaded", () => {
    for (const name of ["bugfix", "small-feature", "docs-update"]) {
      const text = readFileSync(join(root, "templates", `${name}.yaml`), "utf8");
      expect(text).toContain(`id: ${name}`);
      expect(text).toContain("status: not-loaded");
    }
  });

  it("describes replay fixtures without loading them", () => {
    const text = readFileSync(join(root, "evals", "README.md"), "utf8");
    expect(text.toLowerCase()).toContain("replay");
    expect(text).toContain("Nothing in the workspace loads this directory yet.");
  });

  it("finds no model client import under packages/core", () => {
    expect(scanDirectory(join(root, "packages", "core"))).toEqual([]);
  });
});
