import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext, StepId } from "@thin-pr/core";
import { createAnthropicClient, runImplementer, scriptedUpstream, TurnLimitError, type Script } from "@thin-pr/specialists";
import { createMemoryWorkspace } from "@thin-pr/workspace";
import { afterEach, describe, expect, it } from "vitest";
import { createRunHandlers, createVerifyHandler } from "./steps.js";

const passing = { exitCode: 0, logTail: "" };
const failingTest = { exitCode: 1, logTail: "FAIL test/counter.test.ts > clamps at zero" };

describe("verify", () => {
  it("finishes with both check results when they pass", async () => {
    const verify = createVerifyHandler(createMemoryWorkspace({}, { typecheck: passing, test: passing }));

    const result = await verify(context("verify", 0));
    expect(result).toEqual({
      outcome: "done",
      output: {
        summary: "typecheck passed; test passed.",
        checks: [
          { name: "typecheck", command: "pnpm exec tsc --noEmit", exitCode: 0, durationMs: 0, logTail: "" },
          { name: "test", command: "pnpm exec vitest run", exitCode: 0, durationMs: 0, logTail: "" },
        ],
      },
    });
  });

  it("loops back with the failing check and its log tail", async () => {
    const verify = createVerifyHandler(createMemoryWorkspace({}, { typecheck: passing, test: failingTest }));

    const result = await verify(context("verify", 0));
    expect(result).toMatchObject({
      outcome: "loop",
      output: { summary: "typecheck passed; test failed (exit 1)." },
      feedback: "test failed (exit 1): pnpm exec vitest run\nFAIL test/counter.test.ts > clamps at zero",
    });
  });

  it("finishes with the failure once the template allows no more loops", async () => {
    const verify = createVerifyHandler(createMemoryWorkspace({}, { typecheck: passing, test: failingTest }));

    expect((await verify(context("verify", 2))).outcome).toBe("done");
    expect((await verify({ ...context("verify", 0), step: { id: "verify", retries: 0 } })).outcome).toBe("done");
  });
});

describe("implement", () => {
  const plan = { summary: "Change the count.", steps: ["Edit src/counter.ts"] };
  const script: Script = {
    planner: [plan],
    implementer: {
      turns: [
        [{ name: "read_file", input: { path: "src/counter.ts" } }],
        [
          { name: "replace", input: { path: "src/counter.ts", old_text: "count = 1", new_text: "count = 2" } },
          { name: "create_file", input: { path: "src/reset.ts", content: "export const reset = 0;\n" } },
        ],
      ],
      summary: "Set the count to 2 and add reset.",
    },
    reviewer: [{ summary: "Fine.", verdict: "approve", notes: [] }],
    "pr-writer": [{ summary: "pass", title: "Change the count", body: "The count is 2." }],
  };

  it("edits through the tools on a replayed cassette and stops when the model does", async () => {
    const cassettePath = join(temporary(), "implement.jsonl");
    const recorder = createAnthropicClient({ mode: "record", cassettePath, apiKey: "test-key", fetch: scriptedUpstream(script) });
    await createRunHandlers(recorder, counterWorkspace()).implement({ ...context("implement", 0), outputs: { plan } });

    const workspace = counterWorkspace();
    const player = createAnthropicClient({ mode: "replay", cassettePath, fetch: offline }, {});
    const result = await createRunHandlers(player, workspace).implement({ ...context("implement", 0), outputs: { plan } });

    expect(result).toMatchObject({
      outcome: "done",
      output: { summary: "Set the count to 2 and add reset.", files: ["src/counter.ts", "src/reset.ts"] },
    });
    expect(result.usage?.map((call) => call.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5"]);
    expect(await workspace.readFile("src/counter.ts")).toBe("export const count = 2;\n");
    expect(await workspace.readFile("src/reset.ts")).toBe("export const reset = 0;\n");
  });

  it("stops a model that keeps asking for tools at the turn cap", async () => {
    const endless = { ...script, implementer: { turns: Array(5).fill([{ name: "list_files", input: {} }]), summary: "Never." } };
    const fetch = scriptedUpstream(endless);
    let calls = 0;
    const counted: typeof globalThis.fetch = (url, init) => {
      calls += 1;
      return fetch(url, init);
    };
    const { client } = createAnthropicClient({ mode: "live", apiKey: "test-key", fetch: counted });
    const request = { model: "claude-opus-5-5", effort: "high", issue: "Loop.", input: "Plan.", maxTurns: 3 } as const;

    await expect(runImplementer(client, { ...request, workspace: counterWorkspace() })).rejects.toThrow(TurnLimitError);
    expect(calls).toBe(3);
  });
});

const offline: typeof fetch = async () => {
  throw new Error("replay reached the network");
};

function counterWorkspace() {
  return createMemoryWorkspace({ "src/counter.ts": "export const count = 1;\n" }, { typecheck: passing, test: passing });
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "thin-pr-steps-"));
  directories.push(directory);
  return directory;
}

function context(step: StepId, loop: number): StepContext {
  return {
    runId: "run-7",
    issue: "#7 Clamp decrement at zero",
    step: { id: step, retries: 0, loop: { back_to: "implement", max: 2 } },
    outputs: {},
    feedback: null,
    attempt: 1,
    loop,
  };
}
