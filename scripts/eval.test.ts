import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRecord } from "@thin-pr/github";
import { describe, expect, it } from "vitest";
import {
  exitCode,
  formatReport,
  loadCases,
  reportFiles,
  runCases,
  runEval,
  scoreRuns,
  staleReportFiles,
  writeReportFiles,
} from "./eval.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("replay eval", () => {
  it("opens every good case, blocks every bad one, and matches the committed report", { timeout: 240_000 }, async () => {
    const report = await runEval(root);
    const text = formatReport(report);

    expect(report).toMatchObject({
      total: 23,
      correct: 23,
      accuracy: 1,
      minVerdictAccuracy: 1,
      resolved: { count: 11, total: 11 },
      blocked: { count: 12, total: 12 },
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
      "py-01-collapse-slug-spaces": "opened",
      "py-02-minutes-format": "opened",
      "py-03-failing-hidden-test": "tests",
      "py-04-project-config": "paths",
      "py-05-planted-secret": "secrets",
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

    // The Python cases run python3 for both checks on evals/sample-python, and the hidden unittest catches YES.
    const pythonFeature = report.cases.find((item) => item.id === "py-02-minutes-format");
    expect(pythonFeature?.record.repo).toBe("example/sample-python");
    expect(pythonFeature?.record.diff?.files.map((file) => file.path)).toEqual(["src/duration.py", "test/test_duration.py"]);
    expect(pythonFeature?.record.checks.map((check) => `${check.name} ${check.exitCode}: ${check.command}`)).toEqual([
      "typecheck 0: python3 -m compileall -q src test",
      "test 0: PYTHONPATH=src python3 -m unittest discover -s test 2>&1",
    ]);
    const pythonHidden = report.cases.find((item) => item.id === "py-03-failing-hidden-test");
    // Only the lines every Python version prints the same way stay in the committed log.
    expect(pythonHidden?.record.checks.find((check) => check.name === "test")?.logTail).toBe(
      [
        "FAIL: test_reads_yes_and_no_in_any_case (hidden.test_flags.HiddenParseFlagTest)",
        "AssertionError: None is not True",
        "Ran 4 tests",
        "FAILED (failures=1)",
      ].join("\n"),
    );

    expect(text).toContain("verdict accuracy: 23/23 (100.0%)");
    expect(text).toContain("resolve rate: 11/11 (100.0%)");
    expect(text).toContain("cost per resolved case: 0.031228 USD");
    expect(text).toContain("p50 step latency: 3180 ms");
    expect(text).toContain("  claude-opus-5-5: 81 calls, 78053 input tokens, 13033 output tokens, 0.572872 USD");
    expect(text).toContain("blocked bad: 12/12");
    expect(text).toContain("rules failed by a case: diff, budget, paths, secrets, typecheck, tests, review");
    expect(text).toContain("rules no case fails: plan, contracts");
    expect(text).toContain("01-clamp-decrement opened ok files 1 lines 2");
    expect(text).toContain("15-planted-secret blocked ok files 1 lines 3 failed rules: secrets");
    expect(text).toContain("py-05-planted-secret blocked ok files 1 lines 5 failed rules: secrets");
    expect(text).not.toContain("sk-ant-");
    expect(text).not.toContain("AKIA");
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

  it("stops before any case runs when a Python case has no python3 3.10 or later on PATH", async () => {
    const [item] = loadCases(root);
    if (!item) throw new Error("no eval case");
    const python = { ...item, repo: "sample-python" };
    const noSession = () => {
      throw new Error("the case ran");
    };
    // A python3 that reports 3.9, as macOS's /usr/bin/python3 does.
    const old = mkdtempSync(join(tmpdir(), "thin-pr-python-"));
    writeFileSync(join(old, "python3"), "#!/bin/sh\necho 3.9\n", { mode: 0o755 });
    const path = process.env.PATH;
    try {
      process.env.PATH = join(root, "node_modules", ".bin");
      await expect(runCases(root, [python], noSession, 1)).rejects.toThrow(
        "evals/sample-python runs its checks with python3, and python3 is not on PATH. Install Python 3.10 or later.",
      );
      process.env.PATH = old;
      await expect(runCases(root, [python], noSession, 1)).rejects.toThrow(
        "evals/sample-python needs Python 3.10 or later, and python3 is 3.9.",
      );
    } finally {
      process.env.PATH = path;
      rmSync(old, { recursive: true, force: true });
    }
  });

  it("keeps the eval and the python3 its Python cases need on the CI and nightly workflows", () => {
    const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("run: pnpm eval");
    for (const name of ["ci.yml", "nightly-eval.yml"]) {
      expect(readFileSync(join(root, ".github/workflows", name), "utf8")).toContain("uses: actions/setup-python@v7");
    }
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
