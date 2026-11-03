import { describe, expect, it } from "vitest";
import type { RunRecord } from "./record.js";
import { formatRunReport } from "./report.js";

const record: RunRecord = {
  version: 1,
  runId: "run-7",
  repo: "example/sample-repo",
  issue: { number: 7, title: "Fix the stub", url: "https://github.com/example/sample-repo/issues/7" },
  template: "feature",
  status: "blocked",
  steps: [],
  gate: [
    { rule: "typecheck", verdict: "PASS", reason: "Typecheck passed: tsc --noEmit" },
    { rule: "tests", verdict: "FAIL", reason: "Tests failed (exit 1): vitest run | tee log.txt" },
  ],
  diff: null,
  checks: [{ name: "test", command: "vitest run | tee log.txt", exitCode: 1, durationMs: 1200, logTail: "```\nexpected 1\n```\n" }],
  pullRequest: null,
  totals: { costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
};

describe("formatRunReport", () => {
  it("keeps a pipe in a reason inside its table cell", () => {
    const body = formatRunReport({ record, outputs: {}, branch: "thin-pr/7", error: "gate failed: tests" });

    expect(body).toContain("| `tests` | **FAIL** | Tests failed (exit 1): vitest run \\| tee log.txt |");
  });

  it("fences a log tail that contains a fence with a longer one", () => {
    const body = formatRunReport({ record, outputs: {}, branch: "thin-pr/7", error: "gate failed: tests" });

    expect(body).toContain("````text\n```\nexpected 1\n```\n````");
  });
});
