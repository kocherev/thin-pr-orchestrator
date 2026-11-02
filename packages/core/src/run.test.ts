import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openEventLog,
  replay,
  runWorkflow,
  StepError,
  type StepContext,
  type StepHandler,
  type StepId,
  type Template,
  type Usage,
} from "./index.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const template: Template = {
  id: "small-feature",
  label: "thin-pr",
  steps: [
    { id: "plan", retries: 0 },
    { id: "implement", retries: 1 },
    { id: "verify", retries: 0, loop: { back_to: "implement", max: 1 } },
    { id: "review", retries: 0 },
    { id: "write", retries: 0 },
  ],
};

describe("runWorkflow", () => {
  it("replays a run that loops once to the same outputs, loops and usage", async () => {
    const path = logPath();
    const seen: StepContext[] = [];
    const log = openEventLog(path);
    const state = await runWorkflow({
      runId: "run-1",
      issue: "Clamp decrement at zero.",
      template,
      log,
      handlers: handlers({
        implement: async (context) => {
          seen.push(context);
          return { outcome: "done", output: { summary: `edit ${context.loop}` }, usage: [usage(0.02)] };
        },
        verify: async (context) =>
          context.loop === 0
            ? { outcome: "loop", output: { passed: false }, feedback: "test/counter.test.ts failed", usage: [] }
            : { outcome: "done", output: { passed: true } },
      }),
    });
    log.close();

    expect(state.status).toBe("completed");
    expect(state.outputs).toEqual({
      plan: { summary: "plan" },
      implement: { summary: "edit 1" },
      verify: { passed: true },
      review: { summary: "review" },
      write: { summary: "write" },
    });
    expect(state.loops).toEqual({ verify: 1 });
    expect(state.usage.map((item) => item.costUsd)).toEqual([0.01, 0.02, 0.02, 0.01, 0.01]);
    expect(seen.map((context) => [context.loop, context.attempt, context.feedback])).toEqual([
      [0, 1, null],
      [1, 1, "test/counter.test.ts failed"],
    ]);

    const reopened = openEventLog(path);
    const events = reopened.read("run-1");
    reopened.close();
    expect(replay(events)).toEqual(state);
    expect(events.map((event) => `${event.step ?? "run"} ${event.kind}`)).toEqual([
      "run started",
      "plan started",
      "plan finished",
      "implement started",
      "implement finished",
      "verify started",
      "verify looped",
      "implement started",
      "implement finished",
      "verify started",
      "verify finished",
      "review started",
      "review finished",
      "write started",
      "write finished",
      "run completed",
    ]);
  });

  it("fails the run when a step asks to loop past its limit", async () => {
    const log = openEventLog(logPath());
    let implementCalls = 0;
    const state = await runWorkflow({
      runId: "run-1",
      issue: "Clamp decrement at zero.",
      template,
      log,
      handlers: handlers({
        implement: async () => {
          implementCalls += 1;
          return { outcome: "done", output: { summary: "edit" } };
        },
        verify: async () => ({ outcome: "loop", output: { passed: false }, feedback: "still failing" }),
      }),
    });
    const events = log.read("run-1");
    log.close();

    expect(state.status).toBe("failed");
    expect(state.loops).toEqual({ verify: 1 });
    expect(implementCalls).toBe(2);
    expect(events.at(-1)).toMatchObject({ step: null, kind: "failed", error: "verify reached its loop limit (1)" });
    expect(replay(events)).toEqual(state);
  });

  it("retries a step with the previous error as feedback", async () => {
    const log = openEventLog(logPath());
    const seen: (string | null)[] = [];
    const state = await runWorkflow({
      runId: "run-1",
      issue: "Clamp decrement at zero.",
      template,
      log,
      handlers: handlers({
        implement: async (context) => {
          seen.push(context.feedback);
          if (context.attempt === 1) {
            throw new Error("implementer output invalid at files");
          }
          return { outcome: "done", output: { summary: "edit" } };
        },
      }),
    });
    const failed = log.read("run-1").filter((event) => event.kind === "failed");
    log.close();

    expect(state.status).toBe("completed");
    expect(seen).toEqual([null, "implementer output invalid at files"]);
    expect(failed).toEqual([
      expect.objectContaining({ step: "implement", attempt: 1, error: "implementer output invalid at files" }),
    ]);
  });

  it("fails the run when a step runs out of retries", async () => {
    const log = openEventLog(logPath());
    const state = await runWorkflow({
      runId: "run-1",
      issue: "Clamp decrement at zero.",
      template,
      log,
      handlers: handlers({
        plan: async () => {
          throw new Error("planner output invalid at steps");
        },
      }),
    });
    const events = log.read("run-1");
    log.close();

    expect(state.status).toBe("failed");
    expect(state.outputs).toEqual({});
    expect(events.at(-1)).toMatchObject({
      step: null,
      kind: "failed",
      error: "plan failed after 1 attempt: planner output invalid at steps",
    });
  });

  it("reports each event after it is stored", async () => {
    const log = openEventLog(logPath());
    const seen: string[] = [];
    await runWorkflow({
      runId: "run-1",
      issue: "Clamp decrement at zero.",
      template: { ...template, steps: [{ id: "plan", retries: 0 }] },
      log,
      handlers: handlers({
        plan: async () => {
          seen.push("handler");
          return { outcome: "done", output: { summary: "plan" } };
        },
      }),
      onEvent(event) {
        seen.push(`${event.seq} ${event.step ?? "run"} ${event.kind}`);
      },
    });
    log.close();

    expect(seen).toEqual(["1 run started", "2 plan started", "handler", "3 plan finished", "4 run completed"]);
  });
});

describe("failed attempts", () => {
  it("keeps the usage of an attempt that failed after model calls", async () => {
    const path = logPath();
    const log = openEventLog(path);
    let attempts = 0;
    const state = await runWorkflow({
      runId: "run-2",
      issue: "Clamp decrement at zero.",
      template,
      log,
      handlers: handlers({
        implement: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new StepError(new Error("implementer request was refused"), [usage(0.03)]);
          }
          return { outcome: "done", output: { summary: "edit" }, usage: [usage(0.02)] };
        },
      }),
    });
    const events = log.read("run-2");
    log.close();

    expect(state.status).toBe("completed");
    expect(state.usage.map((item) => item.costUsd)).toEqual([0.01, 0.03, 0.02, 0.01, 0.01, 0.01]);
    expect(events.find((event) => event.kind === "failed")).toMatchObject({
      step: "implement",
      error: "implementer request was refused",
      usage: [usage(0.03)],
    });
    expect(replay(events)).toEqual(state);
  });
});

function handlers(overrides: Partial<Record<StepId, StepHandler>>): Record<StepId, StepHandler> {
  const echo =
    (id: StepId): StepHandler =>
    async () => ({ outcome: "done", output: { summary: id }, usage: [usage(0.01)] });
  return {
    plan: overrides.plan ?? echo("plan"),
    implement: overrides.implement ?? echo("implement"),
    verify: overrides.verify ?? echo("verify"),
    review: overrides.review ?? echo("review"),
    write: overrides.write ?? echo("write"),
  };
}

function usage(costUsd: number): Usage {
  return { model: "claude-sonnet-5-5", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, costUsd, durationMs: 5 };
}

function logPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "thin-pr-"));
  directories.push(directory);
  return join(directory, "events.sqlite");
}
