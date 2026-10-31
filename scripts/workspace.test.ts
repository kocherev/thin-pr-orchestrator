import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadTemplate, packageId as coreId, ping } from "@thin-pr/core";
import { packageId as gateId, readiness } from "@thin-pr/gate";
import { packageId as githubId, entrypoint, TRIGGER_LABEL } from "@thin-pr/github";
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
    expect(readiness()).toBe("ready");
    expect(githubId).toBe("@thin-pr/github");
    expect(entrypoint()).toBe("issue-label");
    expect(TRIGGER_LABEL).toBe("thin-pr");
  });

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

  it("loads workflow templates", () => {
    for (const name of ["bugfix", "small-feature", "docs-update"]) {
      const template = loadTemplate(join(root, "templates", `${name}.yaml`));
      expect(template.id).toBe(name);
      expect(template.steps.map((step) => step.specialist)).toEqual([
        "planner",
        "implementer",
        "tester",
        "reviewer",
        "pr-writer",
      ]);
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
