import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { templateForLabel, TemplateError } from "./index.js";

const templates = fileURLToPath(new URL("../../../templates/", import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("templateForLabel", () => {
  it("picks the template whose label matches", () => {
    expect(templateForLabel(templates, "thin-pr")?.id).toBe("small-feature");
    expect(templateForLabel(templates, "thin-pr:bugfix")?.id).toBe("bugfix");
    expect(templateForLabel(templates, "thin-pr:docs")?.id).toBe("docs-update");
    expect(templateForLabel(templates, "bug")).toBeNull();
  });

  it("reads steps with optional model, effort and loop", () => {
    const feature = templateForLabel(templates, "thin-pr");
    expect(feature?.steps.map((step) => step.id)).toEqual(["plan", "implement", "verify", "review", "write"]);
    expect(feature?.steps[1]).toEqual({ id: "implement", model: "claude-opus-5-5", effort: "high", retries: 1 });
    expect(feature?.steps[2]).toEqual({ id: "verify", retries: 0, loop: { back_to: "implement", max: 2 } });
    expect(templateForLabel(templates, "thin-pr:docs")?.steps[2]).toEqual({ id: "verify", retries: 0 });
  });

  it("rejects two templates with the same label", () => {
    const directory = templateDirectory({
      "a.yaml": "id: a\nlabel: thin-pr\nsteps:\n  - { id: plan, retries: 0 }\n",
      "b.yaml": "id: b\nlabel: thin-pr\nsteps:\n  - { id: plan, retries: 0 }\n",
    });
    expect(() => templateForLabel(directory, "thin-pr")).toThrow("label thin-pr names more than one template: a, b");
  });

  it("fails a schema error with the source line", () => {
    const directory = templateDirectory({
      "broken.yaml": [
        "id: broken",
        "label: thin-pr",
        "steps:",
        "  - id: plan",
        "    retries: 0",
        "  - id: verify",
        "    retries: 0",
        "    loop: { back_to: review, max: 1 }",
        "",
      ].join("\n"),
    });
    const error = loadError(directory);
    expect(error.file).toBe("broken.yaml");
    expect(error.line).toBe(8);
    expect(error.message).toContain("broken.yaml:8:");
    expect(error.message).toContain("loop must go back to an earlier step, not review");
  });

  it("rejects a model on the verify step", () => {
    const directory = templateDirectory({
      "broken.yaml": "id: broken\nlabel: thin-pr\nsteps:\n  - { id: verify, model: claude-opus-5-5, retries: 0 }\n",
    });
    expect(loadError(directory).message).toContain("verify runs checks and takes no model");
  });

  it("fails a yaml syntax error with the source line", () => {
    const error = loadError(templateDirectory({ "broken.yaml": "id: [\n" }));
    expect(error.line).toBe(2);
    expect(error.message).toContain("broken.yaml:2:");
  });
});

function templateDirectory(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "thin-pr-"));
  directories.push(directory);
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(directory, name), source);
  }
  return directory;
}

function loadError(directory: string): TemplateError {
  try {
    templateForLabel(directory, "thin-pr");
  } catch (error) {
    if (error instanceof TemplateError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected template load to fail");
}
