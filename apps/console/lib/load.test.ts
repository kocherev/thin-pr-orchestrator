import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEvalReport, loadRuns } from "./load";
import { runRecordSchema } from "./schema";

const evals = join(import.meta.dirname, "..", "..", "..", "evals");
const committedRun = runRecordSchema.parse(JSON.parse(readFileSync(join(evals, "runs", "18-live-edit.json"), "utf8")));

let directory = "";

function writeRun(name: string, record: unknown): void {
  writeFileSync(join(directory, name), JSON.stringify(record));
}

describe("console data", () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "console-runs-"));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("parses every committed eval run and the eval report", () => {
    const files = readdirSync(join(evals, "runs")).filter((name) => name.endsWith(".json"));
    const runs = loadRuns([join(evals, "runs")]);
    expect(runs).toHaveLength(files.length);

    const report = loadEvalReport(join(evals, "report.json"));
    expect(report?.cases.map((evalCase) => `eval-${evalCase.caseId}`).sort()).toEqual(
      runs.map((run) => run.runId).sort(),
    );
  });

  it("names the file and the field when a record does not match the schema", () => {
    writeRun("bad.json", { ...committedRun, status: "merged" });
    expect(() => loadRuns([directory])).toThrow(/bad\.json does not match the schema:[\s\S]*status/);
  });

  it("rejects the same run id in two directories", () => {
    writeRun("copy.json", committedRun);
    expect(() => loadRuns([join(evals, "runs"), directory])).toThrow(/Duplicate runId "eval-18-live-edit"/);
  });

  it("returns no runs when a directory is missing", () => {
    expect(loadRuns([join(directory, "missing")])).toEqual([]);
  });
});
