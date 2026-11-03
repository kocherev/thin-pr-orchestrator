import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext, StepId } from "@thin-pr/core";
import { createAnthropicClient, runImplementer, scriptedUpstream, TurnLimitError, type Script } from "@thin-pr/specialists";
import { createMemoryWorkspace } from "@thin-pr/workspace";
import { afterEach, describe, expect, it } from "vitest";
import { createRunHandlers, createVerifyHandler } from "./steps.js";

const LIMITS = { spendUsd: 5, budget: { max_files: 12, max_lines: 600 } };
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
    "pr-writer": [{ summary: "pass", title: "Change the count" }],
  };

  it("edits through the tools on a replayed cassette and stops when the model does", async () => {
    const cassettePath = join(temporary(), "implement.jsonl");
    const recorder = createAnthropicClient({ mode: "record", cassettePath, apiKey: "test-key", fetch: scriptedUpstream(script) });
    await createRunHandlers(recorder, counterWorkspace(), LIMITS).implement({ ...context("implement", 0), outputs: { plan } });

    const workspace = counterWorkspace();
    const player = createAnthropicClient({ mode: "replay", cassettePath, fetch: offline }, {});
    const result = await createRunHandlers(player, workspace, LIMITS).implement({ ...context("implement", 0), outputs: { plan } });

    expect(result).toMatchObject({
      outcome: "done",
      output: { summary: "Set the count to 2 and add reset.", files: ["src/counter.ts", "src/reset.ts"] },
    });
    expect(result.usage?.map((call) => call.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5"]);
    expect(await workspace.readFile("src/counter.ts")).toBe("export const count = 2;\n");
    expect(await workspace.readFile("src/reset.ts")).toBe("export const reset = 0;\n");
  });

  it("shows the planner the repository's files so its steps name real paths", async () => {
    const fetch = scriptedUpstream(script);
    const bodies: string[] = [];
    const captured: typeof globalThis.fetch = (url, init) => {
      bodies.push(String(init?.body));
      return fetch(url, init);
    };
    const session = createAnthropicClient({ mode: "live", apiKey: "test-key", fetch: captured });
    await createRunHandlers(session, counterWorkspace(), LIMITS).plan(context("plan", 0));

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("Repository files:\\nsrc/counter.ts");
  });

  it("lets the planner read the files it names before it replies", async () => {
    const fetch = scriptedUpstream({ ...script, plannerReads: [[{ name: "read_file", input: { path: "src/counter.ts" } }]] });
    const bodies: { tools?: { name: string }[]; messages: { content: unknown }[] }[] = [];
    const captured: typeof globalThis.fetch = (url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return fetch(url, init);
    };
    const session = createAnthropicClient({ mode: "live", apiKey: "test-key", fetch: captured });
    const result = await createRunHandlers(session, counterWorkspace(), LIMITS).plan(context("plan", 0));

    expect(result).toMatchObject({ outcome: "done", output: plan });
    expect(result.usage).toHaveLength(2);
    expect(bodies[0]?.tools?.map((tool) => tool.name)).toEqual(["read_file", "search"]);
    expect(JSON.stringify(bodies[1]?.messages.at(-1)?.content)).toContain("export const count = 1;");
  });

  it("asks the API to clear old tool results in the implementer's loop", async () => {
    const fetch = scriptedUpstream(script);
    const sent: { headers: Headers; body: Record<string, unknown> }[] = [];
    const captured: typeof globalThis.fetch = (url, init) => {
      sent.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return fetch(url, init);
    };
    const session = createAnthropicClient({ mode: "live", apiKey: "test-key", fetch: captured });
    await createRunHandlers(session, counterWorkspace(), LIMITS).implement({ ...context("implement", 0), outputs: { plan } });

    expect(sent[0]?.headers.get("anthropic-beta")).toContain("context-management-2025-06-27");
    expect(sent[0]?.body.context_management).toEqual({
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: 60_000 },
          keep: { type: "tool_uses", value: 6 },
          clear_at_least: { type: "input_tokens", value: 20_000 },
        },
      ],
    });
  });

  it("caches the conversation in the planner and implementer loops and meters the cache reads", async () => {
    const fetch = scriptedUpstream({ ...script, plannerReads: [[{ name: "read_file", input: { path: "src/counter.ts" } }]] });
    const bodies: Record<string, unknown>[] = [];
    // Every turn after the first reads 800 tokens from the cache, as the API reports it.
    const cached: typeof globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const reply = (await (await fetch(url, init)).json()) as { usage: Record<string, number> };
      const turn = (bodies.at(-1)?.messages as unknown[]).length;
      return Response.json({ ...reply, usage: { ...reply.usage, cache_read_input_tokens: turn > 1 ? 800 : 0 } });
    };
    const session = createAnthropicClient({ mode: "live", apiKey: "test-key", fetch: cached });
    const handlers = createRunHandlers(session, counterWorkspace(), LIMITS);
    const planned = await handlers.plan(context("plan", 0));
    const implemented = await handlers.implement({ ...context("implement", 0), outputs: { plan } });

    expect(bodies.length).toBeGreaterThan(3);
    for (const body of bodies) {
      expect(body).toMatchObject({ cache_control: { type: "ephemeral" }, system: [{ type: "text", cache_control: { type: "ephemeral" } }] });
    }
    expect(planned.usage?.map((call) => call.cacheReadTokens)).toEqual([0, 800]);
    expect(implemented.usage?.map((call) => call.cacheReadTokens)).toEqual([0, 800, 800]);
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

    await expect(runImplementer(client, { ...request, workspace: counterWorkspace(), budget: LIMITS.budget })).rejects.toThrow(TurnLimitError);
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
