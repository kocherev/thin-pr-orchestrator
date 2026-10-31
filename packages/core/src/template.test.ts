import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadTemplate, TemplateError } from "./index.js";

const templates = fileURLToPath(new URL("../../../templates/", import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("template load", () => {
  it("loads the yaml workflows", () => {
    const bugfix = loadTemplate(join(templates, "bugfix.yaml"));
    const feature = loadTemplate(join(templates, "small-feature.yaml"));
    const docs = loadTemplate(join(templates, "docs-update.yaml"));

    expect(bugfix.id).toBe("bugfix");
    expect(feature.id).toBe("small-feature");
    expect(docs.id).toBe("docs-update");
    expect(bugfix.steps.map((step) => [step.id, step.specialist])).toEqual([
      ["plan", "planner"],
      ["implement", "implementer"],
      ["test", "tester"],
      ["review", "reviewer"],
      ["gate", "pr-writer"],
    ]);
    expect(bugfix.steps.find((step) => step.id === "plan")).toMatchObject({
      inputs: ["issue", "templateId"],
      outputs: ["summary", "steps"],
    });
    expect(bugfix.steps.find((step) => step.id === "implement")?.retries).toBe(2);
    expect(feature.steps.find((step) => step.id === "implement")?.retries).toBe(1);
    expect(docs.steps.every((step) => step.retries === 0)).toBe(true);
    expect(bugfix.steps.find((step) => step.id === "gate")?.gate).toBe("decide");
    expect(feature.steps.find((step) => step.id === "gate")?.gate).toBe("decide");
    expect(docs.steps.find((step) => step.id === "gate")?.gate).toBe("decide");
  });

  it("fails a schema error with the source line", () => {
    const path = writeTemplate(
      "broken.yaml",
      [
        "id: broken",
        "steps:",
        "  - id: plan",
        "    specialist: no-such",
        "    retries: 0",
        "    inputs:",
        "      - issue",
        "      - templateId",
        "    outputs:",
        "      - summary",
        "      - steps",
        "",
      ].join("\n"),
    );

    const error = loadError(path);
    expect(error).toBeInstanceOf(TemplateError);
    expect(error.file).toBe("broken.yaml");
    expect(error.line).toBe(4);
    expect(error.message).toContain("broken.yaml:4:");
    expect(error.message).toContain("specialist");
  });

  it("fails a yaml syntax error with the source line", () => {
    const path = writeTemplate("broken.yaml", "id: [\n");
    const error = loadError(path);
    expect(error).toBeInstanceOf(TemplateError);
    expect(error.line).toBe(2);
    expect(error.message).toContain("broken.yaml:2:");
  });
});

function writeTemplate(name: string, source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "thin-pr-"));
  directories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, source);
  return path;
}

function loadError(path: string): TemplateError {
  try {
    loadTemplate(path);
  } catch (error) {
    if (error instanceof TemplateError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected template load to fail");
}
