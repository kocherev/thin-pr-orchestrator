import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exitCode, formatReport, runEval } from "./eval.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("replay eval", () => {
  it("opens every good case and blocks every bad one on the rule it names", { timeout: 240_000 }, async () => {
    const report = await runEval(root);
    const text = formatReport(report);

    expect(report).toMatchObject({
      total: 17,
      correct: 17,
      accuracy: 1,
      minVerdictAccuracy: 1,
      good: { opened: 8, total: 8 },
      bad: { blocked: 9, total: 9 },
      meetsBaseline: true,
    });
    expect(Object.fromEntries(report.cases.map((item) => [item.id, item.failedRules.join(", ") || item.verdict]))).toEqual({
      "01-clamp-decrement": "opened",
      "02-thousands-separator": "opened",
      "03-skip-blank-notes": "opened",
      "04-parse-yes-no": "opened",
      "05-add-reset": "opened",
      "06-document-helpers": "opened",
      "07-format-label": "opened",
      "08-reject-empty-notes": "opened",
      "09-failing-hidden-test": "tests",
      "10-empty-plan": "blocked",
      "11-wide-touch": "budget",
      "12-long-readme": "budget",
      "13-type-error": "typecheck",
      "14-denied-path": "paths",
      "15-planted-secret": "secrets",
      "16-whitespace-only": "diff",
      "17-review-notes": "review",
    });
    const emptyPlan = report.cases.find((item) => item.id === "10-empty-plan");
    expect(emptyPlan?.error).toContain("plan failed after 2 attempts: planner output invalid at steps");
    const failingTest = report.cases.find((item) => item.id === "09-failing-hidden-test");
    expect(failingTest?.record.checks.find((check) => check.name === "test")?.logTail).toContain("reads TRUE as true");
    expect(failingTest?.record.steps.filter((step) => step.id === "verify").map((step) => step.outcome)).toEqual([
      "looped",
      "looped",
      "finished",
    ]);

    expect(text).toContain("verdict accuracy: 17/17 (100.0%)");
    expect(text).toContain("opened good: 8/8");
    expect(text).toContain("blocked bad: 9/9");
    expect(text).toContain("rules failed by a case: diff, budget, paths, secrets, typecheck, tests, review");
    expect(text).toContain("rules no case fails: plan, contracts");
    expect(text).toContain("01-clamp-decrement opened ok files 1 lines 2");
    expect(text).toContain("15-planted-secret blocked ok files 1 lines 3 failed rules: secrets");
    expect(text).not.toContain("sk-ant-");
    expect(exitCode(report)).toBe(0);

    const missed = report.cases.slice(0, 1).map((item) => ({ ...item, verdict: "blocked" as const, correct: false }));
    expect(formatReport({ ...report, cases: missed })).toContain("01-clamp-decrement blocked MISMATCH (expected opened)");
    expect(exitCode({ ...report, meetsBaseline: false })).toBe(1);
  });

  it("keeps the eval on the CI workflow", () => {
    const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("run: pnpm eval");
  });
});
