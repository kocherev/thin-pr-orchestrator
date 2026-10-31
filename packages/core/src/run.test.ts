import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createStubSpecialists, ReplayModelClient } from "@thin-pr/specialists";
import { loadTemplate, openEventLog, parseTemplate, replay, runWorkflow } from "./index.js";

const templatePath = fileURLToPath(new URL("../../../templates/stub-run.json", import.meta.url));
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

  it("rejects a template that names an unknown step", () => {
    expect(() => parseTemplate({ id: "bad", steps: ["plan", "ship"] })).toThrow(
      /unknown template step/,
    );
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
          template: parseTemplate({ id: "one", steps: ["plan"] }),
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
          template: parseTemplate({ id: "one", steps: ["plan"] }),
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
