import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuns } from "./load";
import { runOutcome } from "./run";

const runs = loadRuns([join(import.meta.dirname, "..", "..", "..", "evals", "runs")]);

function committedRun(caseId: string) {
  const found = runs.find((run) => run.runId === `eval-${caseId}`);
  if (!found) throw new Error(`eval-${caseId} is missing from evals/runs`);
  return found;
}

describe("runOutcome", () => {
  it("names the rule that blocked a run and gives its reason", () => {
    expect(runOutcome(committedRun("09-failing-hidden-test"))).toEqual({
      short: "Tests failed",
      headline: "Blocked because one gate rule failed: Tests.",
      detail: expect.stringMatching(/^Tests failed \(exit 1\)/),
    });
  });

  it("says a run over its budget waits for approval", () => {
    const outcome = runOutcome(committedRun("21-document-every-helper"));
    expect(outcome.short).toBe("Over size budget");
    expect(outcome.headline).toMatch(/^Waiting for approval\./);
    expect(outcome.detail).toMatch(/^Diff exceeds the budget/);
  });

  it("points a failed run at the step that stopped it", () => {
    expect(runOutcome(committedRun("10-empty-plan"))).toEqual({
      short: "Stopped at plan",
      headline: "Stopped at the plan step, before the gate could run.",
      detail: "planner output invalid at steps: Too small: expected array to have >=1 items",
    });
  });

  it("has no detail for an opened run", () => {
    expect(runOutcome(committedRun("20-rename-split-lines"))).toMatchObject({ short: "9/9 passed", detail: null });
  });
});
