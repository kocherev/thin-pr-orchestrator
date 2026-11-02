import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@thin-pr/core";
import { afterEach, describe, expect, it } from "vitest";
import { readLabelEvent } from "./event.js";
import { exportRunRecord, toRunRecord, type TimedEvent } from "./record.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const event = readLabelEvent({
  action: "labeled",
  label: { name: "thin-pr" },
  issue: { number: 7, title: "Clamp decrement at zero", body: null },
  repository: { name: "sample-repo", default_branch: "main", owner: { login: "example" } },
});

const usage = { model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, costUsd: 0.03, durationMs: 900 };

describe("toRunRecord", () => {
  it("builds one step entry per attempt, with its pass, timing and usage", () => {
    const timeline = timed([
      { step: null, kind: "started", output: { issue: "#7 Clamp decrement at zero" } },
      { step: "implement", kind: "started", attempt: 1 },
      { step: "implement", kind: "failed", attempt: 1, error: "implementer model text is not JSON" },
      { step: "implement", kind: "started", attempt: 2, feedback: "implementer model text is not JSON" },
      { step: "implement", kind: "finished", attempt: 2, output: { summary: "Clamp at zero." }, usage: [usage] },
      { step: "verify", kind: "started", attempt: 1 },
      { step: "verify", kind: "looped", attempt: 1, output: { passed: false }, feedback: "counter test failed" },
      { step: "implement", kind: "started", attempt: 1, feedback: "counter test failed" },
      { step: "implement", kind: "finished", attempt: 1, output: { summary: "Clamp with Math.max." }, usage: [usage] },
      { step: null, kind: "completed" },
    ]);

    const record = toRunRecord({
      runId: "run-7",
      event,
      template: "small-feature",
      status: "blocked",
      timeline,
      gate: [{ rule: "tests", verdict: "FAIL", reason: "Tests did not pass." }],
      diff: { files: [{ path: "src/counter.ts", added: 1, removed: 1 }], meaningful: true, patch: "" },
      checks: [{ name: "test", command: "vitest run", exitCode: 1, durationMs: 800, logTail: "1 failed" }],
      pullRequest: null,
    });

    expect(record).toMatchObject({
      version: 1,
      runId: "run-7",
      repo: "example/sample-repo",
      issue: { number: 7, title: "Clamp decrement at zero", url: "https://github.com/example/sample-repo/issues/7" },
      template: "small-feature",
      status: "blocked",
      diff: { files: [{ path: "src/counter.ts", added: 1, removed: 1 }], meaningful: true },
      checks: [{ name: "test", exitCode: 1, logTail: "1 failed" }],
      pullRequest: null,
      totals: { costUsd: 0.06, durationMs: 9000, inputTokens: 2000, outputTokens: 400 },
    });
    expect(record.steps).toEqual([
      step("implement", 1, 0, "failed", 1, "implementer model text is not JSON", []),
      step("implement", 2, 0, "finished", 3, "Clamp at zero.", [usage]),
      step("verify", 1, 0, "looped", 5, "counter test failed", []),
      step("implement", 1, 1, "finished", 7, "Clamp with Math.max.", [usage]),
    ]);
  });

  it("writes the record when a path is set", () => {
    const directory = mkdtempSync(join(tmpdir(), "thin-pr-record-"));
    directories.push(directory);
    const path = join(directory, "runs", "run-7.json");
    const record = toRunRecord({
      runId: "run-7",
      event,
      template: "small-feature",
      status: "failed",
      timeline: [],
      gate: [],
      diff: null,
      checks: [],
      pullRequest: null,
    });

    exportRunRecord(record, path);
    exportRunRecord(record, undefined);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(record);
  });
});

// Each event lands one second after the previous one.
function timed(events: (Partial<RunEvent> & Pick<RunEvent, "step" | "kind">)[]): TimedEvent[] {
  return events.map((event, index) => ({
    event: {
      seq: index + 1,
      runId: "run-7",
      templateId: "small-feature",
      attempt: 0,
      output: null,
      feedback: null,
      usage: [],
      error: null,
      ...event,
    },
    at: new Date(Date.UTC(2026, 10, 2, 9, 0, index)),
  }));
}

function step(
  id: string,
  attempt: number,
  loop: number,
  outcome: string,
  second: number,
  summary: string,
  stepUsage: unknown[],
) {
  return {
    id,
    attempt,
    loop,
    outcome,
    startedAt: new Date(Date.UTC(2026, 10, 2, 9, 0, second)).toISOString(),
    durationMs: 1000,
    usage: stepUsage,
    summary,
  };
}
