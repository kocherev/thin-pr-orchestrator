import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JUDGE_CRITERIA, scriptedBatchUpstream, type JudgeSubject, type JudgeVerdict } from "@thin-pr/specialists";
import { describe, expect, it } from "vitest";
import {
  agreement,
  exitCode,
  formatJudgeReport,
  JUDGE_CASSETTE,
  judgeReport,
  loadLabels,
  recordJudge,
  replayJudge,
  runJudge,
  type Label,
} from "./judge.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("judge eval", () => {
  it("keeps a human label for every criterion of every case", () => {
    const labels = loadLabels(root);
    expect(labels.size).toBe(18);
    const fails = Object.fromEntries(
      JUDGE_CRITERIA.map((criterion) => [criterion, [...labels].filter(([, label]) => label[criterion] === "fail").map(([id]) => id)]),
    );
    expect(fails).toEqual({
      plan_relevance: ["10-empty-plan", "14-denied-path"],
      minimal_diff: ["16-whitespace-only"],
      test_adequacy: ["18-live-edit"],
      review_quality: [
        "06-document-helpers",
        "09-failing-hidden-test",
        "10-empty-plan",
        "13-type-error",
        "14-denied-path",
        "15-planted-secret",
        "16-whitespace-only",
      ],
    });
  });

  it("says the judge is pending until a judge cassette is recorded", async () => {
    expect(existsSync(join(root, JUDGE_CASSETTE))).toBe(false);
    const report = await runJudge(root, { record: false, env: {} });
    const text = formatJudgeReport(report);
    expect(text).toContain("judge: claude-sonnet-5-5 at medium effort, one Message Batches request per case");
    expect(text).toContain("always-pass agreement: 61/72 (84.7%)");
    expect(text).toContain("baseline: 90.0%");
    expect(text).toContain("judge cassette: not recorded.");
    expect(exitCode(report)).toBe(0);
    await expect(runJudge(root, { record: true, env: {} })).rejects.toThrow("needs ANTHROPIC_API_KEY");
  });

  it("records one batch, replays it offline, and refuses a stale cassette", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thin-pr-judge-"));
    try {
      const cassettePath = join(dir, "judge-cassette.jsonl");
      const subjects = [subject("01-good"), subject("02-bad")];
      const labels = new Map<string, Label>([
        ["01-good", label({})],
        ["02-bad", label({ review_quality: "fail" })],
      ]);
      const polls: string[] = [];

      const recorded = await recordJudge(subjects, {
        cassettePath,
        env: { ANTHROPIC_API_KEY: "test-key" },
        pollMs: 0,
        fetch: scriptedBatchUpstream({ "01-good": verdict({}), "02-bad": verdict({ minimal_diff: "fail" }) }),
        log: (line) => polls.push(line),
      });
      expect(polls).toEqual(["batch msgbatch_scripted in_progress, 2 processing"]);
      const lines = readFileSync(cassettePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.map((line) => [line.source, line.caseId])).toEqual([
        ["live", "01-good"],
        ["live", "02-bad"],
      ]);

      const replayed = replayJudge(subjects, cassettePath);
      expect(replayed).toEqual(recorded);

      const report = judgeReport(replayed, labels, 0.9);
      if (!report.recorded) throw new Error("expected a recorded report");
      // 02-bad: the judge failed minimal_diff where the label passes, and passed review_quality where the label fails.
      expect(report.agreement).toMatchObject({ matched: 6, total: 8, failsCaught: { matched: 0, total: 1 } });
      expect(report.agreement.byCriterion.review_quality).toEqual({ matched: 1, total: 2 });
      expect(report.meetsBaseline).toBe(false);
      expect(exitCode(report)).toBe(1);
      const text = formatJudgeReport(report);
      expect(text).toContain("judge agreement: 6/8 (75.0%)");
      expect(text).toContain("always-pass agreement: 7/8 (87.5%)");
      expect(text).toContain("fail labels caught: 0/1");
      expect(text).toContain("  minimal_diff: fail MISMATCH (label pass). Graded minimal_diff.");
      expect(text).toMatch(/judge cost: 0\.\d{6} USD at the batch rate/);

      const changed = [subjects[0] ?? subject("01-good"), { ...subject("02-bad"), patch: "+  return 0;" }];
      expect(() => replayJudge(changed, cassettePath)).toThrow(`${cassettePath} is stale for 02-bad`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a case the judge could not grade as agreeing on nothing", () => {
    const counted = agreement([
      { caseId: "01", label: label({}), result: { outcome: "graded", verdict: verdict({}), costUsd: 0 } },
      { caseId: "02", label: label({ plan_relevance: "fail" }), result: { outcome: "error", error: "the request expired", costUsd: 0 } },
    ]);
    expect(counted).toMatchObject({ matched: 4, total: 8, failsCaught: { matched: 0, total: 1 } });
  });

  it("keeps the judge on the CI workflow", () => {
    const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("run: pnpm eval:judge");
  });
});

type Grades = Partial<Record<(typeof JUDGE_CRITERIA)[number], "pass" | "fail">>;

function label(grades: Grades): Label {
  return { plan_relevance: "pass", minimal_diff: "pass", test_adequacy: "pass", review_quality: "pass", note: "Read by hand.", ...grades };
}

function verdict(grades: Grades): JudgeVerdict {
  const grade = (criterion: (typeof JUDGE_CRITERIA)[number]) => ({ verdict: grades[criterion] ?? "pass", reason: `Graded ${criterion}.` });
  return {
    plan_relevance: grade("plan_relevance"),
    minimal_diff: grade("minimal_diff"),
    test_adequacy: grade("test_adequacy"),
    review_quality: grade("review_quality"),
  };
}

function subject(caseId: string): JudgeSubject {
  return {
    caseId,
    issue: "Clamp decrement at zero\n\ndecrement in src/counter.ts should not return a negative count.",
    status: "opened",
    error: null,
    plan: { summary: "Clamp decrement.", steps: ["Change decrement in src/counter.ts"] },
    patch: "-  return value - 1;\n+  return Math.max(0, value - 1);",
    checks: [{ name: "test", command: "vitest run", exitCode: 0, durationMs: 0, logTail: "" }],
    review: { summary: "Fine.", verdict: "approve", notes: [] },
  };
}
