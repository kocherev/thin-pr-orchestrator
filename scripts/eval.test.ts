import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRecord, Verdict } from "@thin-pr/github";
import { describe, expect, it } from "vitest";
import {
  exitCode,
  formatReport,
  loadCases,
  runCases,
  scoreRuns,
  staleReportFiles,
  writeReportFiles,
} from "./eval.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("replay eval", () => {
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
    // A case that should wait for approval scores on its own. It is neither resolved nor blocked.
    const waiting = scoreRuns([scored("awaiting_approval", "awaiting_approval", []), scored("awaiting_approval", "opened", [])]);
    expect(waiting).toMatchObject({ correct: 1, awaiting: { count: 1, total: 2 }, resolved: { count: 0, total: 0 } });
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

  it("prints a MISMATCH line and exits 1 when a case misses its verdict", () => {
    const missed = { ...scored("opened", "blocked", []), id: "01-clamp-decrement", title: "Case", actual: "blocked" as const };
    const item = { ...missed, failedRules: [], error: null, outputs: {} };
    const report = { ...scoreRuns([item]), cases: [item], minVerdictAccuracy: 1, meetsBaseline: false };
    expect(formatReport(report)).toContain("01-clamp-decrement blocked MISMATCH (expected opened)");
    expect(exitCode(report)).toBe(1);
  });

  // pnpm test does not run the eval. pnpm eval runs it once, in CI and in pnpm verify, and fails when the committed
  // report or run records are stale.
  it("keeps the eval and the python3 its Python cases need on the CI and nightly workflows", () => {
    const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("run: pnpm eval");
    expect(readFileSync(join(root, "scripts/verify.sh"), "utf8")).toMatch(/^for step in lint typecheck test eval /m);
    for (const name of ["ci.yml", "nightly-eval.yml"]) {
      expect(readFileSync(join(root, ".github/workflows", name), "utf8")).toContain("uses: actions/setup-python@");
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

function scored(expected: Verdict, verdict: Verdict, steps: Step[]) {
  const costUsd = steps.flatMap((item) => item.usage).reduce((sum, item) => sum + item.costUsd, 0);
  const record: RunRecord = {
    version: 1,
    runId: "eval",
    repo: "example/sample-repo",
    issue: { number: 1, title: "Case", url: "https://example.test/1" },
    template: "feature",
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
