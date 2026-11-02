import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RunRecord } from "@thin-pr/github";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./server.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

const RULES = ["plan", "contracts", "diff", "budget", "paths", "secrets", "typecheck", "tests", "review"] as const;

const PASSED = RULES.map((rule) => ({
  rule,
  verdict: "PASS" as const,
  reason: "ok",
}));

const OPENED: RunRecord = {
  version: 1,
  runId: "local-1",
  repo: "local/sample-repo",
  issue: { number: 1, title: "Clamp decrement at zero", url: "" },
  template: "small-feature",
  status: "opened",
  steps: [],
  gate: PASSED,
  diff: { files: [{ path: "src/counter.ts", added: 1, removed: 1 }], meaningful: true, patch: "" },
  checks: [],
  pullRequest: null,
  totals: { costUsd: 0.0123, durationMs: 9000, inputTokens: 1000, outputTokens: 200 },
};

const BLOCKED: RunRecord = {
  ...OPENED,
  runId: "local-2",
  issue: { number: 2, title: "Match uppercase true", url: "" },
  status: "blocked",
  gate: PASSED.map((rule) => (rule.rule === "tests" ? { ...rule, verdict: "FAIL" as const } : rule)),
};

describe("thin-pr MCP server", () => {
  it("lists the four tools", async () => {
    const client = await connect(undefined);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["list_runs", "get_run", "replay_case", "start_run"]);
    expect(tools.find((tool) => tool.name === "start_run")?.inputSchema.required).toEqual(["repo", "issue"]);
  });

  it("lists the runs newest first and returns one in full", async () => {
    const dir = runsDir();
    writeRun(dir, "local-1.json", OPENED, 1_000);
    writeRun(dir, "local-2.json", BLOCKED, 2_000);
    writeFileSync(join(dir, "notes.json"), "not json");
    const client = await connect(dir);

    const list = await client.callTool({ name: "list_runs", arguments: {} });
    const run = await client.callTool({ name: "get_run", arguments: { runId: "local-1" } });

    expect(list.structuredContent).toEqual({
      runs: [
        { runId: "local-2", issue: "Match uppercase true", status: "blocked", gate: "failed: tests", costUsd: 0.0123 },
        { runId: "local-1", issue: "Clamp decrement at zero", status: "opened", gate: "passed 9/9", costUsd: 0.0123 },
      ],
      skipped: ["notes.json"],
    });
    expect(run.isError).toBeFalsy();
    expect(run.structuredContent).toEqual(OPENED);
  });

  it("answers a bad call with a tool error and keeps serving", async () => {
    const client = await connect(runsDir());

    const missing = await client.callTool({ name: "get_run", arguments: { runId: "local-9" } });
    const unknownCase = await client.callTool({ name: "replay_case", arguments: { caseId: "../sample-repo" } });
    const relative = await client.callTool({ name: "start_run", arguments: { repo: "repo", issue: "Fix it" } });
    const unset = await (await connect(undefined)).callTool({ name: "list_runs", arguments: {} });

    expect(missing).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("no RunRecord with runId local-9") }] });
    expect(unknownCase).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("unknown case ../sample-repo") }] });
    expect(relative).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("must be an absolute path") }] });
    expect(unset).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("THIN_PR_RUNS_DIR is not set") }] });
    expect((await client.listTools()).tools).toHaveLength(4);
  });

  // Verify loops twice on the hidden test, so tsc and vitest run three times.
  it("replays an eval case and blocks it on its hidden test, as expected.json says", { timeout: 90_000 }, async () => {
    const client = await connect(undefined);

    const result = await client.callTool({ name: "replay_case", arguments: { caseId: "09-failing-hidden-test" } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      caseId: "09-failing-hidden-test",
      expected: { verdict: "blocked", failedRules: ["tests"] },
      verdict: "blocked",
      failedRules: ["tests"],
      correct: true,
      record: { status: "blocked", issue: { title: "Match uppercase true" }, pullRequest: null },
    });
  });
});

async function connect(dir: string | undefined): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ runsDir: dir });
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return client;
}

function runsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "thin-pr-runs-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRun(dir: string, name: string, record: RunRecord, mtimeSeconds: number): void {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  utimesSync(path, mtimeSeconds, mtimeSeconds);
}
