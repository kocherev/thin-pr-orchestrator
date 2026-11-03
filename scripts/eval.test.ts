import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRecord } from "@thin-pr/github";
import { describe, expect, it } from "vitest";
import { exitCode, formatReport, reportFiles, runEval, scoreRuns, staleReportFiles, writeReportFiles } from "./eval.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("replay eval", () => {
  it("opens every good case, blocks every bad one, and matches the committed report", { timeout: 240_000 }, async () => {
    const report = await runEval(root);
    const text = formatReport(report);

    expect(report).toMatchObject({
      total: 18,
      correct: 18,
      accuracy: 1,
      minVerdictAccuracy: 1,
      resolved: { count: 9, total: 9 },
      blocked: { count: 9, total: 9 },
      meetsBaseline: true,
    });
    expect(Object.fromEntries(report.cases.map((item) => [item.id, item.failedRules.join(", ") || item.actual]))).toEqual({
      "01-clamp-decrement": "opened",
      "02-thousands-separator": "opened",
      "03-skip-blank-notes": "opened",
      "04-parse-yes-no": "opened",
      "05-add-reset": "opened",
      "06-document-helpers": "opened",
      "07-format-label": "opened",
      "08-reject-empty-notes": "opened",
      "09-failing-hidden-test": "tests",
      "10-empty-plan": "failed",
      "11-wide-touch": "budget",
      "12-long-readme": "budget",
      "13-type-error": "typecheck",
      "14-denied-path": "paths",
      "15-planted-secret": "secrets",
      "16-whitespace-only": "diff",
      "17-review-notes": "review",
      "18-live-edit": "opened",
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
    // The first attempt renders 999999 as 1000k. The hidden test sends it back once, and the second attempt passes.
    const liveEdit = report.cases.find((item) => item.id === "18-live-edit");
    expect(liveEdit?.record.steps.map((step) => `${step.id} ${step.outcome}`)).toEqual([
      "plan finished",
      "implement finished",
      "verify looped",
      "implement finished",
      "verify finished",
      "review finished",
      "write finished",
    ]);
    expect(liveEdit?.record.steps[2]?.summary).toContain("expected '1000k' to be '1M'");

    expect(text).toContain("verdict accuracy: 18/18 (100.0%)");
    expect(text).toContain("resolve rate: 9/9 (100.0%)");
    expect(text).toContain("cost per resolved case: 0.029992 USD");
    expect(text).toContain("p50 step latency: 3195 ms");
    expect(text).toContain("  claude-opus-5-5: 61 calls, 57680 input tokens, 9828 output tokens, 0.427280 USD");
    expect(text).toContain("blocked bad: 9/9");
    expect(text).toContain("rules failed by a case: diff, budget, paths, secrets, typecheck, tests, review");
    expect(text).toContain("rules no case fails: plan, contracts");
    expect(text).toContain("01-clamp-decrement opened ok files 1 lines 2");
    expect(text).toContain("15-planted-secret blocked ok files 1 lines 3 failed rules: secrets");
    expect(text).not.toContain("sk-ant-");
    expect(exitCode(report)).toBe(0);

    // The committed report and run records hold no clock time and no scratch path, so a fresh run reproduces them.
    expect(staleReportFiles(root, reportFiles(report))).toEqual([]);

    const missed = report.cases.slice(0, 1).map((item) => ({ ...item, verdict: "blocked" as const, correct: false }));
    expect(formatReport({ ...report, cases: missed })).toContain("01-clamp-decrement blocked MISMATCH (expected opened)");
    expect(exitCode({ ...report, meetsBaseline: false })).toBe(1);
  });

  it("scores resolve rate, cost per resolved case, p50 step latency and model totals", () => {
    const scores = scoreRuns([
      scored("opened", "opened", [step(1000, [usage("claude-sonnet-5-5", 0.01)]), step(4000, [usage("claude-opus-5-5", 0.2)])]),
      scored("opened", "blocked", [step(2000, [usage("claude-opus-5-5", 0.1)]), step(0, [])]),
      scored("opened", "opened", [step(3000, [usage("claude-opus-5-5", 0.09), usage("claude-opus-5-5", 0.01)])]),
      scored("blocked", "blocked", [step(9000, [usage("claude-sonnet-5-5", 0.5)])]),
    ]);

    expect(scores).toMatchObject({
      correct: 3,
      total: 4,
      accuracy: 0.75,
      resolved: { count: 2, total: 3 },
      blocked: { count: 1, total: 1 },
    });
    // The three cases expected to open spent 0.41 USD and two of them opened. Blocked cases do not count.
    expect(scores.costPerResolvedUsd).toBeCloseTo(0.205, 10);
    // Model steps take 1000, 2000, 3000, 4000 and 9000 ms. A step without a model call is not a model step.
    expect(scores.p50StepMs).toBe(3000);
    expect(scores.byModel).toEqual([
      { model: "claude-opus-5-5", calls: 4, inputTokens: 400, outputTokens: 40, costUsd: expect.closeTo(0.4, 10) },
      { model: "claude-sonnet-5-5", calls: 2, inputTokens: 200, outputTokens: 20, costUsd: expect.closeTo(0.51, 10) },
    ]);
    expect(scoreRuns([scored("opened", "blocked", [step(0, [])])])).toMatchObject({ costPerResolvedUsd: null, p50StepMs: null });
  });

  it("names the first stale line, a missing file and a run file with no case", () => {
    const dir = mkdtempSync(join(tmpdir(), "thin-pr-report-"));
    try {
      const files = new Map([
        ["evals/report.json", '{\n  "version": 1\n}\n'],
        ["evals/runs/01-a.json", '{\n  "runId": "a"\n}\n'],
      ]);
      expect(staleReportFiles(dir, files)).toEqual(["evals/report.json is missing", "evals/runs/01-a.json is missing"]);

      writeReportFiles(dir, files);
      expect(staleReportFiles(dir, files)).toEqual([]);

      writeFileSync(join(dir, "evals/runs/99-gone.json"), "{}\n");
      writeFileSync(join(dir, "evals/report.json"), '{\n  "version": 2\n}\n');
      expect(staleReportFiles(dir, files)).toEqual([
        "evals/runs/99-gone.json has no eval case",
        'evals/report.json line 2 differs\n  committed:   "version": 2\n  fresh:       "version": 1',
      ]);

      writeReportFiles(dir, files);
      expect(staleReportFiles(dir, files)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the eval on the CI workflow", () => {
    const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("run: pnpm eval");
  });
});

type Step = RunRecord["steps"][number];

function usage(model: string, costUsd: number): Step["usage"][number] {
  return { model, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, costUsd, durationMs: 0 };
}

function step(durationMs: number, calls: Step["usage"]): Step {
  return { id: "plan", attempt: 1, loop: 0, outcome: "finished", startedAt: "2026-11-02T00:00:00.000Z", durationMs, usage: calls, summary: "" };
}

function scored(expected: "opened" | "blocked", verdict: "opened" | "blocked", steps: Step[]) {
  const costUsd = steps.flatMap((item) => item.usage).reduce((sum, item) => sum + item.costUsd, 0);
  const record: RunRecord = {
    version: 1,
    runId: "eval",
    repo: "example/sample-repo",
    issue: { number: 1, title: "Case", url: "https://example.test/1" },
    template: "small-feature",
    status: verdict,
    steps,
    gate: [],
    diff: null,
    checks: [],
    pullRequest: null,
    totals: { costUsd, durationMs: 0, inputTokens: 0, outputTokens: 0 },
  };
  return { expected: { verdict: expected }, verdict, correct: expected === verdict, record };
}
