import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { templateForLabel } from "@thin-pr/core";
import { createAnthropicClient, scriptedUpstream, type ModelSession, type Script } from "@thin-pr/specialists";
import { createScratchRepo, loadRepoConfig } from "@thin-pr/workspace";
import { openApprovedDraft, readStoredRun, type StoredRun } from "./approval.js";
import { runAction, runLimits, type LabelRunResult } from "./run.js";
import type { GitHubSurface } from "./surface.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const cleanups: (() => void)[] = [];

type Call = { readonly op: string } & Readonly<Record<string, unknown>>;

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const STUB = "export function stub(): number {\n  return 0;\n}\n";
const PASSING_CHECKS = "checks:\n  typecheck: echo typecheck ok\n  test: echo test ok\n";

const STUB_SCRIPT: Script = {
  planner: [{ summary: "Plan the stub change.", steps: ["edit the stub"] }],
  implementer: {
    turns: [
      [{ name: "read_file", input: { path: "src/stub.ts" } }],
      [{ name: "replace", input: { path: "src/stub.ts", old_text: "return 0;", new_text: "return 1;" } }],
    ],
    summary: "Apply the stub change.",
  },
  reviewer: [{ summary: "Stub review found nothing.", verdict: "approve", notes: [] }],
  "pr-writer": [{ summary: "pass", title: "Fix the stub", body: "Stub draft." }],
};

describe("issue label", () => {
  it("pushes the branch and opens a draft when every gate rule passes", async () => {
    const repo = scratch(PASSING_CHECKS);
    const memory = memoryGitHub();
    const result = await run(repo, memory.github, { model: cassette("gate-pass") });

    expect(result.status).toBe("opened");
    if (result.status !== "opened") {
      return;
    }
    const modelSteps = result.record.steps.filter((step) => step.id !== "verify");
    expect(modelSteps.every((step) => step.usage.length > 0 && step.usage.every((call) => call.costUsd > 0))).toBe(true);
    expect(result.record.steps.find((step) => step.id === "implement")?.usage.map((call) => call.model)).toEqual([
      "claude-opus-5-5",
      "claude-opus-5-5",
      "claude-opus-5-5",
    ]);
    expect(result.record.totals.costUsd).toBeCloseTo(
      modelSteps.flatMap((step) => step.usage).reduce((sum, call) => sum + call.costUsd, 0),
      12,
    );
    expect(result.record.totals.inputTokens).toBeGreaterThan(0);
    const head = git(repo.remote, "rev-parse", "thin-pr/7");
    expect(git(repo.remote, "log", "--format=%s", "thin-pr/7")).toBe("Apply thin-pr/#7\nBase");
    expect(git(repo.remote, "show", "thin-pr/7:src/stub.ts")).toContain("return 1;");
    expect(result.record).toMatchObject({
      status: "opened",
      diff: { files: [{ path: "src/stub.ts", added: 1, removed: 1 }], meaningful: true },
      checks: [
        { name: "typecheck", command: "echo typecheck ok", exitCode: 0, logTail: "typecheck ok\n" },
        { name: "test", command: "echo test ok", exitCode: 0, logTail: "test ok\n" },
      ],
      pullRequest: { number: 11, url: "https://github.com/example/sample-repo/pull/11" },
    });
    expect(result.record.gate.map((rule) => `${rule.rule} ${rule.verdict}`)).toEqual([
      "plan PASS",
      "contracts PASS",
      "diff PASS",
      "budget PASS",
      "paths PASS",
      "secrets PASS",
      "typecheck PASS",
      "tests PASS",
      "review PASS",
    ]);

    const checkShas = memory.calls.filter((call) => call.op === "startCheck").map((call) => [call.name, call.sha]);
    expect(checkShas.slice(0, 5)).toEqual(
      ["plan", "implement", "verify", "review", "write"].map((step) => [`thin-pr / ${step}`, repo.baseSha]),
    );
    expect(checkShas.slice(5).every(([, sha]) => sha === head)).toBe(true);
    const pullCalls = memory.calls.filter((call) => !call.op.endsWith("Comment"));
    expect(pullCalls.at(-2)).toMatchObject({ op: "listPullsForHead", branch: "thin-pr/7" });
    const draft = pullCalls.at(-1);
    expect(draft).toMatchObject({ op: "openDraft", title: "Fix the stub", head: "thin-pr/7", base: "main", draft: true });
    const body = String(draft?.body);
    expect(body.split("\n")[0]).toBe("**Gate passed.** All 9 rules passed for #7.");
    expect(gateRows(body)).toEqual(result.record.gate.map((rule) => `${rule.rule} PASS`));
    expect(body).toMatch(/^Run: 0\.\d{6} USD, [\d,]+ input and [\d,]+ output tokens, .+ end to end\.$/m);
    expect(body).toMatch(/^- `claude-opus-5-5`: 3 requests, /m);
    expect(sections(body)).toEqual([
      "Plan",
      "Checks: typecheck exit 0, test exit 0",
      "Review: approve",
      "Run report: 5 step runs, 0 loops, 0 retries",
    ]);
    expect(body).toContain("Plan the stub change.\n\n- edit the stub");
    expect(finalComment(memory.calls).split("\n")[0]).toBe(
      "**Gate passed.** All 9 rules passed for #7. Draft: https://github.com/example/sample-repo/pull/11",
    );
  });

  it("creates one progress comment, edits it at each step, and ends it as the run report", async () => {
    const repo = scratch(PASSING_CHECKS);
    const memory = memoryGitHub();
    const directory = mkdtempSync(join(tmpdir(), "thin-pr-label-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const result = await runAction({
      payload: readFixture(),
      templates: join(root, "templates"),
      checkout: repo.dir,
      baseSha: repo.baseSha,
      runId: "run-7",
      logPath: join(directory, "events.sqlite"),
      github: memory.github,
      model: () => cassette("gate-pass"),
      runLink: "[Actions run 9](https://github.com/example/sample-repo/actions/runs/9)",
    });
    expect(result.status).toBe("opened");

    const created = memory.calls.filter((call) => call.op === "createComment");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ issue: 7 });
    const bodies = [created[0], ...memory.calls.filter((call) => call.op === "editComment")].map((call) => String(call?.body));
    expect(new Set(memory.calls.filter((call) => call.op === "editComment").map((call) => call.commentId)).size).toBe(1);
    expect(bodies[0]?.split("\n")[0]).toBe(
      "**Running the feature template on #7.** Run `run-7`, [Actions run 9](https://github.com/example/sample-repo/actions/runs/9). Cost so far: 0.000000 USD.",
    );
    expect(bodies[0]).toContain("| plan | pending |  |  | 0.000000 USD |");
    expect(bodies[0]).toContain("| gate | pending | | | |");
    expect(bodies[1]).toContain("| plan | running | 1 | 0 | 0.000000 USD |");
    expect(bodies[2]).toMatch(/\| plan \| done \| 1 \| 0 \| 0\.\d{6} USD \|/);
    expect(bodies[2]).not.toContain("Cost so far: 0.000000 USD");
    // Five steps, each started and finished, then the gate, then the final report.
    expect(bodies).toHaveLength(1 + 10 + 1 + 1);
    expect(bodies.at(-2)).toContain("| gate | running | | | |");
    expect(bodies.at(-1)?.split("\n")[0]).toBe(
      "**Gate passed.** All 9 rules passed for #7. Draft: https://github.com/example/sample-repo/pull/11",
    );
    expect(sections(bodies.at(-1) ?? "")).toContain("Run report: 5 step runs, 0 loops, 0 retries");
  });

  it("comments the run report and pushes nothing when a gate rule fails", async () => {
    const repo = scratch(PASSING_CHECKS);
    const memory = memoryGitHub();
    const result = await run(repo, memory.github, { model: cassette("gate-fail") });

    expect(result).toMatchObject({ status: "blocked", error: "gate failed: review" });
    if (result.status !== "blocked") {
      return;
    }
    expect(result.record.steps.filter((step) => step.id === "review").map((step) => step.outcome)).toEqual([
      "looped",
      "looped",
      "finished",
    ]);
    expect(git(repo.remote, "branch", "--list", "thin-pr/7")).toBe("");
    expect(memory.calls.some((call) => call.op === "openDraft" || call.op === "listPullsForHead")).toBe(false);
    const ruleChecks = memory.calls.filter((call) => call.op === "startCheck" && String(call.name).includes("/ gate /"));
    expect(ruleChecks.every((call) => call.sha === repo.baseSha)).toBe(true);
    const comment = memory.calls.find((call) => call.op === "createComment");
    expect(comment).toMatchObject({ issue: 7, owner: "example", repo: "sample-repo" });
    const body = finalComment(memory.calls);
    expect(body.split("\n")[0]).toBe("**Gate failed.** 1 of 9 rules failed: `review`. Nothing was pushed.");
    expect(gateRows(body)[0]).toBe("review FAIL");
    expect(body).toContain("| `review` | **FAIL** | Reviewer requested changes (1 note). |");
    expect(sections(body)).toContain("Review: changes_requested");
    expect(sections(body)).toContain("Run report: 11 step runs, 2 loops, 0 retries");
  });

  it("loops verify back to implement on a failing test, then blocks on the tests rule", async () => {
    const repo = scratch("checks:\n  typecheck: 'true'\n  test: echo '1 failed'; exit 1\n");
    const memory = memoryGitHub();
    const result = await run(repo, memory.github, { model: scripted(STUB_SCRIPT) });

    expect(result).toMatchObject({ status: "blocked", error: "gate failed: tests" });
    if (result.status !== "blocked") {
      return;
    }
    expect(result.record.steps.map((step) => `${step.id} ${step.loop} ${step.outcome}`)).toEqual([
      "plan 0 finished",
      "implement 0 finished",
      "verify 0 looped",
      "implement 1 finished",
      "verify 1 looped",
      "implement 2 finished",
      "verify 2 finished",
      "review 0 finished",
      "write 0 finished",
    ]);
    expect(result.record.steps[2]?.summary).toBe("test failed (exit 1): echo '1 failed'; exit 1\n1 failed\n");
    expect(result.record.gate.find((rule) => rule.rule === "tests")?.reason).toBe(
      "Tests failed (exit 1): echo '1 failed'; exit 1",
    );
    const body = finalComment(memory.calls);
    expect(gateRows(body)[0]).toBe("tests FAIL");
    expect(sections(body)).toContain("Checks: typecheck exit 0, test exit 1 (open)");
    expect(body).toContain("`test` exited 1 in ");
    expect(body).toContain("```text\n1 failed\n```");
  });

  it("runs install before the first step and fails the run with its log tail when the install fails", async () => {
    const repo = scratch(`install: echo 'lockfile is out of date'; exit 3\n${PASSING_CHECKS}`);
    const memory = memoryGitHub();
    const result = await run(repo, memory.github, { model: cassette("gate-pass") });

    expect(result).toMatchObject({
      status: "failed",
      error: "install failed (exit 3): echo 'lockfile is out of date'; exit 3\nlockfile is out of date\n",
    });
    if (result.status !== "failed") {
      return;
    }
    expect(result.record.steps).toEqual([]);
    const body = finalComment(memory.calls);
    expect(body.split("\n")[0]).toBe("**Run failed.** install failed (exit 3): echo 'lockfile is out of date'; exit 3");
    expect(body).toContain("```text\nlockfile is out of date\n```");
    expect(body).toContain("The gate did not run.");
    expect(git(repo.remote, "branch", "--list", "thin-pr/7")).toBe("");
  });

  it("blocks a run whose implementer changed nothing", async () => {
    const repo = scratch(PASSING_CHECKS);
    const memory = memoryGitHub();
    const result = await run(repo, memory.github, {
      model: scripted({ ...STUB_SCRIPT, implementer: { turns: [], summary: "Nothing to change." } }),
    });

    expect(result).toMatchObject({ status: "blocked", error: "gate failed: diff" });
    expect(finalComment(memory.calls)).toContain("| `diff` | **FAIL** | Diff is empty. |");
  });

  it("comments the run report when a step fails", async () => {
    const repo = scratch(PASSING_CHECKS);
    const memory = memoryGitHub();
    const result = await run(repo, memory.github, {
      model: scripted({ ...STUB_SCRIPT, planner: [{ summary: 1, steps: ["edit the stub"] }] }),
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "plan failed after 2 attempts: planner output invalid at summary: Invalid input: expected string, received number",
    });
    if (result.status !== "failed") {
      return;
    }
    expect(result.record.steps.map((step) => [step.id, step.attempt, step.outcome])).toEqual([
      ["plan", 1, "failed"],
      ["plan", 2, "failed"],
    ]);
    const body = finalComment(memory.calls);
    expect(body.split("\n")[0]).toMatch(/^\*\*Run failed\.\*\* plan failed after 2 attempts: /);
    expect(sections(body)).toContain("Run report: 2 step runs, 0 loops, 1 retry");
    expect(body).toMatch(/^\| plan \| 2 \| 0 \| failed \| .* \| planner output invalid at summary/m);
    expect(memory.calls.some((call) => call.op === "openDraft")).toBe(false);
  });

  it("stops the run without a retry when the next model call could pass spend_usd", async () => {
    // The planner's request could cost 0.16 USD and fits 0.2. The implementer's could cost 0.64 USD and does not.
    const repo = scratch(`spend_usd: 0.2\n${PASSING_CHECKS}`);
    const memory = memoryGitHub();
    const result = await run(repo, memory.github, { model: scripted(STUB_SCRIPT) });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      return;
    }
    expect(result.error).toMatch(/^implement stopped: the next model call could pass the run's spend_usd of 0\.2 USD \(0\.\d{6} USD spent\)$/);
    expect(result.record.steps.map((step) => `${step.id} ${step.attempt} ${step.outcome}`)).toEqual([
      "plan 1 finished",
      "implement 1 failed",
    ]);
    const body = finalComment(memory.calls);
    expect(body.split("\n")[0]).toBe(`**Run failed.** ${result.error}`);
    expect(git(repo.remote, "branch", "--list", "thin-pr/7")).toBe("");
  });

  it("fails the step with the refusal category when the model declines", async () => {
    const repo = scratch(PASSING_CHECKS);
    const memory = memoryGitHub();
    const refusing: typeof fetch = async () =>
      Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: "refusal",
        stop_sequence: null,
        stop_details: { type: "refusal", category: "cyber", explanation: null },
        usage: { input_tokens: 300, output_tokens: 0 },
      });
    const model = createAnthropicClient({ mode: "live", apiKey: "test-key", fetch: refusing }, {});
    const result = await run(repo, memory.github, { model });

    expect(result).toMatchObject({
      status: "failed",
      error: "plan failed after 2 attempts: planner request was refused by claude-sonnet-5-5 (category: cyber)",
    });
    expect(finalComment(memory.calls)).toContain("(category: cyber)");
    if (result.status !== "failed") {
      return;
    }
    // Both refused attempts were billed for their input, so the run totals count them.
    expect(result.record.steps.map((step) => [step.id, step.outcome, step.usage.length])).toEqual([
      ["plan", "failed", 1],
      ["plan", "failed", 1],
    ]);
    expect(result.record.totals.inputTokens).toBe(600);
    expect(result.record.totals.costUsd).toBeCloseTo((600 * 2) / 1_000_000, 12);
  });

  it("sends review notes back to implement once, then opens the draft when the reviewer approves", async () => {
    const repo = scratch(PASSING_CHECKS);
    const memory = memoryGitHub();
    const changes = { summary: "The stub needs a comment.", verdict: "changes_requested", notes: ["Say why stub returns 1."] };
    const result = await run(repo, memory.github, {
      model: scripted({ ...STUB_SCRIPT, reviewer: [changes, ...STUB_SCRIPT.reviewer] }),
    });

    expect(result.status).toBe("opened");
    if (result.status !== "opened") {
      return;
    }
    expect(result.record.steps.map((step) => `${step.id} ${step.loop} ${step.outcome}`)).toEqual([
      "plan 0 finished",
      "implement 0 finished",
      "verify 0 finished",
      "review 0 looped",
      "implement 1 finished",
      "verify 1 finished",
      "review 1 finished",
      "write 0 finished",
    ]);
    expect(result.record.steps[3]?.summary).toBe("Review notes:\n- Say why stub returns 1.");
    expect(result.record.gate.find((rule) => rule.rule === "review")?.reason).toBe("Reviewer approved.");
  });

  it("resets the branch from the fresh base and updates the open draft when the label is added again", async () => {
    const repo = scratch(PASSING_CHECKS);
    const first = memoryGitHub();
    expect((await run(repo, first.github, { model: cassette("gate-pass") })).status).toBe("opened");
    const firstHead = git(repo.remote, "rev-parse", "thin-pr/7");

    // The default branch moves on. The next run starts from a fresh clone, as actions/checkout gives it.
    const clone = cloneAndCommit(repo.remote, "README.md", "# Sample\n");
    const second = memoryGitHub({ openPull: { number: 11, url: "https://github.com/example/sample-repo/pull/11" } });
    const result = await run(clone, second.github, { model: cassette("gate-pass") });

    expect(result.status).toBe("opened");
    expect(git(repo.remote, "rev-parse", "thin-pr/7^")).toBe(clone.baseSha);
    expect(git(repo.remote, "rev-parse", "thin-pr/7")).not.toBe(firstHead);
    expect(git(repo.remote, "rev-list", "--count", "main..thin-pr/7")).toBe("1");
    expect(second.calls.some((call) => call.op === "openDraft")).toBe(false);
    const update = second.calls.filter((call) => call.op === "updatePull").at(-1);
    expect(update).toMatchObject({ number: 11 });
    expect(update?.body).toMatch(/^\*\*Gate passed\.\*\*/);
  });

  it("comments the setup error when the model cannot start", async () => {
    const repo = scratch(PASSING_CHECKS);
    const memory = memoryGitHub();
    const result = await runAction({
      payload: readFixture(),
      templates: join(root, "templates"),
      checkout: repo.dir,
      baseSha: repo.baseSha,
      runId: "run-7",
      logPath: join(mkdtempSync(join(tmpdir(), "thin-pr-label-")), "events.sqlite"),
      github: memory.github,
      model: () => createAnthropicClient({ mode: "live" }, {}),
    });

    expect(result).toMatchObject({ status: "failed", error: "ANTHROPIC_API_KEY is missing" });
    expect(finalComment(memory.calls)).toMatch(/^\*\*Run failed\.\*\* ANTHROPIC_API_KEY is missing\n/);
    expect(memory.calls.some((call) => call.op === "startCheck")).toBe(false);
  });

  it("ignores a label other than thin-pr", async () => {
    const repo = scratch(PASSING_CHECKS);
    const memory = memoryGitHub();
    const payload = { ...readFixture(), label: { name: "bug" } };
    const result = await run(repo, memory.github, { model: scripted(STUB_SCRIPT), payload });

    expect(result).toEqual({ status: "ignored" });
    expect(memory.calls).toEqual([]);
  });

  it("points the workflow at the label, the full checkout and a neutral commit identity", () => {
    const workflow = readFileSync(join(root, ".github/workflows/thin-pr.yml"), "utf8");
    expect(workflow).toContain("types: [labeled]");
    expect(workflow).toContain("github.event.label.name == 'thin-pr'");
    expect(workflow).toContain("packages/github/src/action.ts");
    expect(workflow).toContain("actions/checkout@v7");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("persist-credentials: false");
    expect(readFileSync(fileURLToPath(new URL("./labeled.ts", import.meta.url)), "utf8")).toContain("pushToken: input.token");
    expect(workflow).toContain("GIT_AUTHOR_NAME: thin-pr[bot]");
    expect(workflow).toContain("GIT_COMMITTER_EMAIL: thin-pr@example.invalid");
    expect(workflow).toContain("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}");
    expect(workflow).not.toContain("THIN_PR_MODEL");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("checks: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("pull-requests: write");
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).not.toContain("THIN_PR_MODEL");
    expect(ci).not.toContain("ANTHROPIC_API_KEY");
  });

  it("keeps GitHub clients inside packages/github", () => {
    const hits: string[] = [];
    for (const name of ["core", "specialists", "gate", "workspace"]) {
      for (const file of typescriptFiles(join(root, "packages", name))) {
        for (const specifier of specifiers(readFileSync(file, "utf8"))) {
          if (isGitHubClient(specifier)) {
            hits.push(`${file}: ${specifier}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);

    for (const name of ["action.ts", "run.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
      expect(source).not.toContain("pulls");
    }
    const surface = readFileSync(fileURLToPath(new URL("./surface.ts", import.meta.url)), "utf8");
    expect(surface).toContain("pulls");
    expect(surface).toContain("draft: true");
  });
});

describe("approval", () => {
  // The stub change is 2 lines, so a 1-line override puts it over the budget while every other rule passes.
  const OVER_BUDGET = `budget:\n  max_lines: 1\n${PASSING_CHECKS}`;

  async function awaitingRun() {
    const repo = scratch(OVER_BUDGET);
    const memory = memoryGitHub();
    const result = await run(repo, memory.github, { model: cassette("gate-pass") });
    if (result.status !== "awaiting_approval") {
      throw new Error(`expected awaiting_approval, got ${result.status}`);
    }
    const comment = finalComment(memory.calls);
    return { repo, memory, result, comment };
  }

  it("pushes the branch over the budget, opens no draft, and comments how to approve", async () => {
    const { repo, memory, result, comment } = await awaitingRun();

    const head = git(repo.remote, "rev-parse", "thin-pr/7");
    expect(git(repo.remote, "show", "thin-pr/7:src/stub.ts")).toContain("return 1;");
    expect(memory.calls.some((call) => call.op === "openDraft" || call.op === "updatePull")).toBe(false);
    expect(result.record).toMatchObject({ status: "awaiting_approval", pullRequest: null });
    expect(result.stored).toMatchObject({ branch: { name: "thin-pr/7", head, base: "main" }, title: "Fix the stub" });
    expect(result.record.gate.filter((rule) => rule.verdict !== "PASS")).toEqual([
      { rule: "budget", verdict: "NEEDS_APPROVAL", reason: "Diff exceeds the budget (1 file, 2 lines; limit 12 files, 1 line)." },
    ]);
    const budgetCheck = memory.calls.findIndex((call) => call.op === "startCheck" && call.name === "thin-pr / gate / budget");
    expect(memory.calls[budgetCheck]).toMatchObject({ sha: head });
    expect(memory.calls[budgetCheck + 1]).toMatchObject({ op: "finishCheck", conclusion: "neutral", title: "NEEDS_APPROVAL" });

    const [first, , second] = comment.split("\n");
    expect(first).toBe(
      "**Waiting for approval.** Diff exceeds the budget (1 file, 2 lines; limit 12 files, 1 line). The other 8 rules passed. `thin-pr/7` is pushed, and no draft is open.",
    );
    expect(second).toMatch(/^To open the draft, a user with write access comments `\/thin-pr approve` on this issue\. /);
    expect(gateRows(comment)[0]).toBe("budget NEEDS_APPROVAL");
    expect(sections(comment)).toContain("Diff: 1 file, 1 added, 1 removed (open)");
    expect(comment).toContain("| `src/stub.ts` | 1 | 1 |");
    expect(readStoredRun(comment)).toEqual(result.stored);
  });

  it("opens the draft for an approved run after re-checking the stored run and the branch", async () => {
    const { repo, comment } = await awaitingRun();
    const stored = readStoredRun(comment);
    if (!stored) throw new Error("no stored run in the comment");
    const approver = memoryGitHub({ remote: repo.remote });

    const approved = await openApprovedDraft(stored, { github: approver.github, approvedBy: "octocat" });

    expect(approved).toMatchObject({
      status: "opened",
      record: { status: "opened", pullRequest: { number: 11, url: "https://github.com/example/sample-repo/pull/11" } },
    });
    expect(approver.calls.map((call) => call.op)).toEqual(["branchHead", "listPullsForHead", "openDraft"]);
    const draft = approver.calls.at(-1);
    expect(draft).toMatchObject({ title: "Fix the stub", head: "thin-pr/7", base: "main", draft: true });
    const body = String(draft?.body);
    expect(body.split("\n")[0]).toBe(
      "**Gate passed with approval.** Diff exceeds the budget (1 file, 2 lines; limit 12 files, 1 line). octocat approved it. The other 8 rules passed for #7.",
    );
    expect(body).toContain("Plan the stub change.\n\n- edit the stub");
    expect(sections(body)).toContain("Review: approve");
  });

  it("refuses an approval when the branch moved, the run is not waiting, or the stored gate fails", async () => {
    const { repo, comment } = await awaitingRun();
    const stored = readStoredRun(comment);
    if (!stored) throw new Error("no stored run in the comment");
    const approve = async (input: StoredRun) => {
      const approver = memoryGitHub({ remote: repo.remote });
      const result = await openApprovedDraft(input, { github: approver.github, approvedBy: "octocat" });
      expect(approver.calls.some((call) => call.op === "openDraft" || call.op === "updatePull")).toBe(false);
      return result;
    };

    expect(await approve({ ...stored, record: { ...stored.record, status: "blocked" } })).toEqual({
      status: "refused",
      reason: "Run run-7 is blocked, not awaiting approval.",
    });
    const failing = stored.record.gate.map((rule) => (rule.rule === "tests" ? { ...rule, verdict: "FAIL" as const } : rule));
    expect(await approve({ ...stored, record: { ...stored.record, gate: failing } })).toEqual({
      status: "refused",
      reason: "The stored gate results decide fail, not needs_approval.",
    });

    const moved = cloneAndCommit(repo.remote, "README.md", "# Sample\n");
    git(moved.dir, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/thin-pr/7");
    const result = await approve(stored);
    expect(result.status).toBe("refused");
    expect(result.status === "refused" && result.reason).toBe(
      `\`thin-pr/7\` now points at ${moved.baseSha.slice(0, 7)}, and the gate measured ${stored.branch.head.slice(0, 7)}. Run thin-pr again to gate the branch as it is.`,
    );
    expect(readStoredRun("no marker here")).toBeNull();
    expect(readStoredRun("<!-- thin-pr-run:bm90IGpzb24= -->")).toBeNull();
  });
});

describe("runLimits", () => {
  it("takes each budget field and the spend from .thin-pr.yml when it sets one, and the rest from the template", () => {
    const feature = templateForLabel(join(root, "templates"), "thin-pr");
    if (!feature) throw new Error("no feature template");
    expect(runLimits(feature, loadRepoConfig(scratch(PASSING_CHECKS).dir))).toEqual({
      budget: { max_files: 12, max_lines: 600 },
      spendUsd: 5,
    });
    expect(runLimits(feature, loadRepoConfig(scratch("budget:\n  max_lines: 40\nspend_usd: 0.5\n").dir))).toEqual({
      budget: { max_files: 12, max_lines: 40 },
      spendUsd: 0.5,
    });
  });
});

/** The body the run's issue comment ends with: the last edit, or the comment itself when it was never edited. */
function finalComment(calls: readonly Call[]): string {
  return String(calls.filter((call) => call.op === "createComment" || call.op === "editComment").at(-1)?.body);
}

/** Each gate table row as "rule VERDICT", in the order the body lists them. */
function gateRows(body: string): string[] {
  return [...body.matchAll(/^\| `(\w+)` \| \**(PASS|FAIL|NEEDS_APPROVAL)\** \|/gm)].map((match) => `${match[1]} ${match[2]}`);
}

/** The summary of each collapsible section, marked when it opens by default. */
function sections(body: string): string[] {
  return [...body.matchAll(/^<details( open)?>\n<summary>(.*)<\/summary>$/gm)].map(
    (match) => `${match[2]}${match[1] ? " (open)" : ""}`,
  );
}

function readFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "fixtures", "sample-issue-labeled.json"), "utf8")) as Record<string, unknown>;
}

function cassette(name: string): ModelSession {
  return createAnthropicClient({ mode: "replay", cassettePath: join(root, "fixtures", `${name}.jsonl`) }, {});
}

function scripted(script: Script): ModelSession {
  return createAnthropicClient({ mode: "live", apiKey: "test-key", fetch: scriptedUpstream(script) }, {});
}

type Checkout = { readonly dir: string; readonly baseSha: string };

function scratch(config: string) {
  const repo = createScratchRepo({ "src/stub.ts": STUB, ".thin-pr.yml": config });
  cleanups.push(() => repo.remove());
  return repo;
}

function cloneAndCommit(remote: string, path: string, content: string): Checkout {
  const parent = mkdtempSync(join(tmpdir(), "thin-pr-clone-"));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  const dir = join(parent, "checkout");
  git(parent, "clone", "--quiet", remote, dir);
  for (const [key, value] of [
    ["user.name", "thin-pr"],
    ["user.email", "thin-pr@localhost"],
    ["commit.gpgsign", "false"],
  ] as const) {
    git(dir, "config", key, value);
  }
  writeFileSync(join(dir, path), content);
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--message", "Move main");
  git(dir, "push", "--quiet", "origin", "main");
  return { dir, baseSha: git(dir, "rev-parse", "HEAD") };
}

async function run(
  checkout: Checkout,
  github: GitHubSurface,
  options: { readonly model: ModelSession; readonly payload?: unknown },
): Promise<LabelRunResult> {
  const directory = mkdtempSync(join(tmpdir(), "thin-pr-label-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return runAction({
    payload: options.payload ?? readFixture(),
    templates: join(root, "templates"),
    checkout: checkout.dir,
    baseSha: checkout.baseSha,
    runId: "run-7",
    logPath: join(directory, "events.sqlite"),
    github,
    model: () => options.model,
  });
}

/** An in-memory GitHub. Branch heads come from `remote`, the bare repo the run pushes to. */
function memoryGitHub(options?: { readonly openPull?: { readonly number: number; readonly url: string }; readonly remote?: string }) {
  const calls: Call[] = [];
  let nextId = 1;
  const github: GitHubSurface = {
    async startCheck(input) {
      calls.push({ op: "startCheck", ...input });
      nextId += 1;
      return nextId - 1;
    },
    async finishCheck(input) {
      calls.push({ op: "finishCheck", ...input });
    },
    async createComment(input) {
      calls.push({ op: "createComment", ...input });
      nextId += 1;
      return nextId - 1;
    },
    async editComment(input) {
      calls.push({ op: "editComment", ...input });
    },
    async branchHead(input) {
      calls.push({ op: "branchHead", ...input });
      if (!options?.remote) {
        return null;
      }
      const refs = git(options.remote, "for-each-ref", "--format=%(objectname)", `refs/heads/${input.branch}`);
      return refs.length > 0 ? refs : null;
    },
    async listPullsForHead(input) {
      calls.push({ op: "listPullsForHead", ...input });
      return options?.openPull ? [options.openPull] : [];
    },
    async updatePull(input) {
      calls.push({ op: "updatePull", ...input });
      return { number: input.number, url: `https://github.com/${input.owner}/${input.repo}/pull/${input.number}` };
    },
    async openDraft(input) {
      calls.push({ op: "openDraft", ...input });
      return { number: 11, url: `https://github.com/${input.owner}/${input.repo}/pull/11` };
    },
  };
  return { github, calls };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function specifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1]] : [])));
}

function isGitHubClient(specifier: string): boolean {
  const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? specifier);
  return name === "@thin-pr/github" || name.startsWith("@octokit/") || name.startsWith("@actions/");
}

function typescriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "node_modules" || entry === "dist") {
      return [];
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return typescriptFiles(path);
    }
    return entry.endsWith(".ts") ? [path] : [];
  });
}
