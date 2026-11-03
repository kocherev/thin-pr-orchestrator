import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCorrect, summarizeEvals } from "./evals";
import { loadEvalReport, loadExpected } from "./load";

const evals = join(import.meta.dirname, "..", "..", "..", "evals");
const report = loadEvalReport(join(evals, "report.json"));
const expected = loadExpected(join(evals, "cases"));

function committedCase(caseId: string) {
  const found = report?.cases.find((evalCase) => evalCase.caseId === caseId);
  if (!found) throw new Error(`${caseId} is missing from evals/report.json`);
  return found;
}

describe("eval scores", () => {
  it("counts a run that failed before the gate as blocked", () => {
    const emptyPlan = committedCase("10-empty-plan");
    expect(emptyPlan).toMatchObject({ expected: "blocked", actual: "failed" });
    expect(isCorrect(emptyPlan, expected.get(emptyPlan.caseId))).toBe(true);
    expect(isCorrect({ ...emptyPlan, expected: "opened" }, undefined)).toBe(false);
  });

  it("requires the labeled gate rules to fail", () => {
    const hiddenTest = committedCase("09-failing-hidden-test");
    expect(expected.get(hiddenTest.caseId)?.failedRules).toEqual(["tests"]);
    expect(isCorrect(hiddenTest, expected.get(hiddenTest.caseId))).toBe(true);
    expect(isCorrect({ ...hiddenTest, failedRules: ["review"] }, expected.get(hiddenTest.caseId))).toBe(false);
  });

  it("finds a label for every case in the report", () => {
    if (!report) throw new Error("evals/report.json is missing");
    expect(report.cases.filter((evalCase) => !expected.has(evalCase.caseId))).toEqual([]);
    expect(summarizeEvals(report, expected).total).toBe(report.cases.length);
  });
});
