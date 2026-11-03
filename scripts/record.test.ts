import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropicClient, scriptedUpstream, type Script } from "@thin-pr/specialists";
import { afterEach, describe, expect, it } from "vitest";
import { loadCases, runCases } from "./eval.js";
import { recordCases } from "./record.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CASE = "01-clamp-decrement";

const script: Script = {
  planner: [{ summary: "Clamp decrement at zero.", steps: ["Change decrement in src/counter.ts"] }],
  implementer: {
    turns: [
      [{ name: "read_file", input: { path: "src/counter.ts" } }],
      [{ name: "replace", input: { path: "src/counter.ts", old_text: "  return value - 1;", new_text: "  return Math.max(0, value - 1);" } }],
    ],
    summary: "decrement stops at zero.",
  },
  reviewer: [{ summary: "The clamp matches the issue.", verdict: "approve", notes: [] }],
  "pr-writer": [{ summary: "Clamp decrement.", title: "Clamp decrement at zero", body: "decrement stops at zero." }],
};

const workspaces: string[] = [];

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A copy of the cases, the sample repo and the templates, with this repo's tsc and vitest. */
function copyWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "thin-pr-record-test-"));
  workspaces.push(dir);
  cpSync(join(root, "evals"), join(dir, "evals"), { recursive: true });
  cpSync(join(root, "templates"), join(dir, "templates"), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  return dir;
}

describe("eval:record", () => {
  it("refuses to run without an API key or with an unknown case", async () => {
    await expect(recordCases({ cases: [CASE], env: {} })).rejects.toThrow("needs ANTHROPIC_API_KEY");
    await expect(recordCases({ cases: ["99-missing"], env: { ANTHROPIC_API_KEY: "test-key" } })).rejects.toThrow(
      "no eval case named 99-missing",
    );
  });

  it("rewrites a case cassette with live lines that replay to the same verdict", { timeout: 120_000 }, async () => {
    const workspace = copyWorkspace();
    const lines: string[] = [];
    const result = await recordCases({
      workspace,
      cases: [CASE],
      env: { ANTHROPIC_API_KEY: "test-key" },
      fetch: scriptedUpstream(script),
      log: (line) => lines.push(line),
    });

    expect(result.recorded).toEqual([CASE]);
    expect(result.stoppedAt).toBeNull();
    expect(result.spentUsd).toBeGreaterThan(0);
    expect(lines).toEqual([`${CASE} opened ${result.spentUsd.toFixed(6)} USD`]);

    const [item] = loadCases(workspace).filter((loaded) => loaded.id === CASE);
    if (!item) throw new Error("case missing");
    const entries = readFileSync(item.cassette, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { source: string; recordedAt: string; specialist: string });
    expect(entries.map((entry) => entry.specialist)).toEqual(["planner", "implementer", "implementer", "implementer", "reviewer", "pr-writer"]);
    expect(entries.every((entry) => entry.source === "live" && !Number.isNaN(Date.parse(entry.recordedAt)))).toBe(true);
    expect(item.recordedAt).toBe(entries[0]?.recordedAt);

    const [replayed] = await runCases(workspace, [item], () => createAnthropicClient({ mode: "replay", cassettePath: item.cassette }), 1);
    expect(replayed).toMatchObject({ actual: "opened", correct: true });
    expect(replayed?.record.totals.costUsd).toBeCloseTo(result.spentUsd, 10);
  });

  it("records nightly with a spend cap, read-only, and never on pull requests", () => {
    const workflow = readFileSync(join(root, ".github/workflows/nightly-eval.yml"), "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("schedule:");
    expect(workflow).not.toMatch(/pull_request|push:/);
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toMatch(/: write|git push/);
    expect(workflow).toContain('THIN_PR_SPEND_LIMIT_USD: "15"');
    expect(workflow).toContain("run: pnpm eval:record --all");
    expect(workflow).toContain("run: pnpm eval:judge -- --record");
  });

  it("stops at the spend limit and keeps the old cassette", { timeout: 120_000 }, async () => {
    const workspace = copyWorkspace();
    const cassette = join(workspace, "evals", "cases", CASE, "cassette.jsonl");
    const before = readFileSync(cassette, "utf8");
    const lines: string[] = [];
    // The planner's first request could cost 0.16 USD at 16,000 output tokens, which passes a 0.05 USD limit.
    const result = await recordCases({
      workspace,
      cases: "all",
      env: { ANTHROPIC_API_KEY: "test-key", THIN_PR_SPEND_LIMIT_USD: "0.05" },
      fetch: scriptedUpstream(script),
      log: (line) => lines.push(line),
    });

    expect(result).toEqual({ recorded: [], spentUsd: 0, stoppedAt: CASE });
    expect(lines).toEqual([`${CASE} stopped at the 0.05 USD limit after 0.000000 USD. Its cassette is unchanged.`]);
    expect(readFileSync(cassette, "utf8")).toBe(before);
  });
});
