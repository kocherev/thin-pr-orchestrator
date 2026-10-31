import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { decide } from "@thin-pr/gate";
import { createStubSpecialists, ReplayModelClient } from "@thin-pr/specialists";
import { loadTemplate, openEventLog, parseTemplate, replay, runWorkflow } from "./index.js";

const templatePath = fileURLToPath(new URL("../../../templates/stub-run.json", import.meta.url));
const bugfixPath = fileURLToPath(new URL("../../../templates/bugfix.yaml", import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("orchestrator run", () => {
  it("replays the stored log to the same final state", async () => {
    const first = await runInNewLog();
    const reopened = openEventLog(first.path);
    try {
      const fromDisk = replay(reopened.read(first.state.runId));
      expect(fromDisk).toEqual(first.state);
      expect(fromDisk.phase).toBe("complete");
      expect(fromDisk.outputs.map((output) => output.summary)).toEqual([
        "Plan the stub change.",
        "Apply the stub change.",
        "Stub checks passed.",
        "Stub review found nothing.",
        "pass",
      ]);
    } finally {
      reopened.close();
    }

    const second = await runInNewLog();
    expect(second.state).toEqual(first.state);
    expect(second.events).toEqual(first.events);

    const truncated = replay(first.events.slice(0, -1));
    expect(truncated).not.toEqual(first.state);
  });

  it("runs the bugfix yaml through the specialists named in the file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thin-pr-"));
    directories.push(directory);
    const log = openEventLog(join(directory, "events.sqlite"));
    try {
      const state = await runWorkflow({
        runId: "run-1",
        issue: "Fix the stub.",
        template: loadTemplate(bugfixPath),
        specialists: createStubSpecialists(),
        gates: { decide },
        log,
      });
      expect(state.templateId).toBe("bugfix");
      expect(state.phase).toBe("complete");
      expect(state.outputs.map((output) => output.step)).toEqual([
        "plan",
        "implement",
        "test",
        "review",
        "gate",
      ]);
    } finally {
      log.close();
    }
  });

  it("retries a step the number of times the template allows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thin-pr-"));
    directories.push(directory);
    const log = openEventLog(join(directory, "events.sqlite"));
    let calls = 0;
    try {
      const state = await runWorkflow({
        runId: "run-1",
        issue: "Fix the stub.",
        template: planTemplate(1),
        specialists: {
          planner: {
            async run(input) {
              calls += 1;
              if (calls === 1) {
                throw new Error("not yet");
              }
              return { step: input.step, summary: "done" };
            },
          },
        },
        log,
      });
      expect(calls).toBe(2);
      expect(state.outputs).toEqual([{ step: "plan", summary: "done" }]);
      expect(log.read("run-1")).toHaveLength(2);
    } finally {
      log.close();
    }
  });

  it("runs the gate hook named by the template", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thin-pr-"));
    directories.push(directory);
    const log = openEventLog(join(directory, "events.sqlite"));
    try {
      await expect(
        runWorkflow({
          runId: "run-1",
          issue: "Fix the stub.",
          template: gateTemplate(),
          specialists: {
            "pr-writer": {
              async run(input) {
                return { step: input.step, summary: "pass" };
              },
            },
          },
          gates: { decide: () => "fail" },
          log,
        }),
      ).rejects.toThrow("gate decide returned fail");
      expect(log.read("run-1")).toEqual([
        expect.objectContaining({ from: "idle", to: "gate", output: null }),
      ]);
    } finally {
      log.close();
    }
  });

  it("rejects a template that names an unknown step", () => {
    expect(() =>
      parseTemplate({
        id: "bad",
        steps: [
          {
            id: "ship",
            specialist: "planner",
            retries: 0,
            inputs: ["issue"],
            outputs: ["summary"],
          },
        ],
      }),
    ).toThrow(/template invalid at steps\.0\.id/);
  });

  it("reports a transition before the specialist runs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thin-pr-"));
    directories.push(directory);
    const log = openEventLog(join(directory, "events.sqlite"));
    const seen: string[] = [];
    try {
      await runWorkflow({
        runId: "run-1",
        issue: "Fix the stub.",
        template: planTemplate(),
        specialists: {
          planner: {
            async run() {
              seen.push("specialist");
              return { step: "plan", summary: "done" };
            },
          },
        },
        log,
        onTransition(transition) {
          const mark =
            transition.output === null ? `enter:${transition.to}` : `leave:${transition.output.step}`;
          seen.push(mark);
        },
      });
      expect(seen).toEqual(["enter:plan", "specialist", "leave:plan"]);
    } finally {
      log.close();
    }
  });

  it("writes nothing when a specialist is missing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thin-pr-"));
    directories.push(directory);
    const path = join(directory, "events.sqlite");
    const log = openEventLog(path);
    try {
      await expect(
        runWorkflow({
          runId: "run-1",
          issue: "Fix the stub.",
          template: planTemplate(),
          specialists: {},
          log,
        }),
      ).rejects.toThrow(/missing specialist/);
      expect(log.read("run-1")).toEqual([]);
    } finally {
      log.close();
    }
  });

  it("fails the step when specialist output does not match the schema", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thin-pr-"));
    directories.push(directory);
    const path = join(directory, "events.sqlite");
    const log = openEventLog(path);
    try {
      await expect(
        runWorkflow({
          runId: "run-1",
          issue: "Fix the stub.",
          template: planTemplate(),
          specialists: createStubSpecialists(
            new ReplayModelClient({
              planner: JSON.stringify({ summary: 1, steps: ["edit the stub"] }),
            }),
          ),
          log,
        }),
      ).rejects.toThrow("planner output invalid at summary: Invalid input: expected string, received number");
      expect(log.read("run-1")).toEqual([
        expect.objectContaining({ from: "idle", to: "plan", output: null }),
      ]);
    } finally {
      log.close();
    }
  });
});

function planTemplate(retries = 0) {
  return parseTemplate({
    id: "one",
    steps: [
      {
        id: "plan",
        specialist: "planner",
        retries,
        inputs: ["issue", "templateId"],
        outputs: ["summary", "steps"],
      },
    ],
  });
}

function gateTemplate() {
  return parseTemplate({
    id: "one",
    steps: [
      {
        id: "gate",
        specialist: "pr-writer",
        retries: 0,
        inputs: ["issue", "reviewSummary"],
        outputs: ["summary", "title", "body"],
        gate: "decide",
      },
    ],
  });
}

async function runInNewLog() {
  const directory = mkdtempSync(join(tmpdir(), "thin-pr-"));
  directories.push(directory);
  const path = join(directory, "events.sqlite");
  const log = openEventLog(path);
  try {
    const state = await runWorkflow({
      runId: "run-1",
      issue: "Fix the stub.",
      template: loadTemplate(templatePath),
      specialists: createStubSpecialists(),
      gates: { decide },
      log,
    });
    const events = log.read(state.runId);
    const folded = replay(events);
    expect(folded).toEqual(state);
    expect(events.length).toBe(state.outputs.length * 2);
    return { path, state, events };
  } finally {
    log.close();
  }
}
