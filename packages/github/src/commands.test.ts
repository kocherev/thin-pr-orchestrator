import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAnthropicClient, scriptedUpstream, type Script } from "@thin-pr/specialists";
import { createScratchRepo } from "@thin-pr/workspace";
import { readStoredRun } from "./approval.js";
import { HELP, runCommand } from "./commands.js";
import type { LabelEvent } from "./event.js";
import { git, memoryGitHub, type StoredComment } from "./fake-github.js";
import type { CommandTrigger } from "./router.js";
import { runAction, type LabelRunResult } from "./run.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const SELF = "thin-pr[bot]";
const REPO = { owner: "example", name: "sample-repo", defaultBranch: "main" };
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
  "pr-writer": [{ summary: "pass", title: "Fix the stub" }],
};
// The stub change is 2 lines, so a 1-line budget puts it over while every other rule passes.
const OVER_BUDGET = "budget:\n  max_lines: 1\nchecks:\n  typecheck: echo typecheck ok\n  test: echo test ok\n";

function command(name: CommandTrigger["command"], issue: Partial<CommandTrigger["issue"]> = {}): CommandTrigger {
  return {
    kind: "command",
    repo: REPO,
    issue: { number: 7, title: "Sample thin pull request", body: "", labels: ["thin-pr"], pull: false, ...issue },
    command: name,
    comment: { id: 55, author: "octocat" },
  };
}

const noRetry = async (): Promise<LabelRunResult> => {
  throw new Error("this command must not start a run");
};

/** A run over the budget on issue 7: the branch is pushed, and the run comment stores the run. */
async function awaitingRun() {
  const repo = createScratchRepo({ "src/stub.ts": "export function stub(): number {\n  return 0;\n}\n", ".thin-pr.yml": OVER_BUDGET });
  cleanups.push(() => repo.remove());
  const directory = mkdtempSync(join(tmpdir(), "thin-pr-command-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const first = memoryGitHub({ self: SELF });
  const result = await runAction({
    payload: JSON.parse(readFileSync(join(root, "fixtures", "sample-issue-labeled.json"), "utf8")) as unknown,
    templates: join(root, "templates"),
    checkout: repo.dir,
    baseSha: repo.baseSha,
    runId: "run-7",
    logPath: join(directory, "events.sqlite"),
    github: first.github,
    // The prompts state the 1-line budget, so the gate-pass recording no longer matches.
    model: () => createAnthropicClient({ mode: "live", apiKey: "test-key", fetch: scriptedUpstream(STUB_SCRIPT) }, {}),
  });
  if (result.status !== "awaiting_approval") {
    throw new Error(`expected awaiting_approval, got ${result.status}`);
  }
  return { repo, result, comments: first.comments };
}

function reactions(calls: readonly { readonly op: string; readonly content?: unknown }[]): unknown[] {
  return calls.filter((call) => call.op === "react").map((call) => call.content);
}

describe("/thin-pr approve", () => {
  it("opens the draft from the run comment the token wrote, after re-checking it", async () => {
    const { repo, result, comments } = await awaitingRun();
    const memory = memoryGitHub({ self: SELF, remote: repo.remote, comments });

    const outcome = await runCommand(command("approve"), { github: memory.github, retry: noRetry, botLogin: SELF });

    expect(outcome).toEqual({ status: "approved", detail: "https://github.com/example/sample-repo/pull/11" });
    expect(memory.calls.find((call) => call.op === "openDraft")).toMatchObject({ head: "thin-pr/7", base: "main", draft: true });
    expect(memory.calls.find((call) => call.op === "branchHead")).toMatchObject({ branch: "thin-pr/7" });
    expect(reactions(memory.calls)).toEqual(["eyes", "+1"]);
    expect(memory.calls.some((call) => call.op === "createComment")).toBe(false);
    // The run comment becomes the approved report, and keeps no stored run to approve twice.
    const runComment = memory.comments.find((comment) => comment.author === SELF);
    expect(runComment?.body.split("\n")[0]).toBe(
      "**Gate passed with approval.** Diff exceeds the budget (1 file, 2 lines; limit 12 files, 1 line). octocat approved it. The other 8 rules passed for #7. Draft: https://github.com/example/sample-repo/pull/11",
    );
    expect(readStoredRun(runComment?.body ?? "")).toBeNull();
    expect(result.stored.branch.head).toBe(git(repo.remote, "rev-parse", "thin-pr/7"));

    const again = memoryGitHub({ self: SELF, remote: repo.remote, comments: memory.comments });
    expect(await runCommand(command("approve"), { github: again.github, retry: noRetry, botLogin: SELF })).toEqual({
      status: "refused",
      reason: "No run on #7 waits for approval.",
    });
    expect(again.calls.some((call) => call.op === "openDraft")).toBe(false);
  });

  it("never reads a stored run from a user's comment or another bot's comment", async () => {
    const { repo, comments } = await awaitingRun();
    // The same marker, pasted elsewhere: it names the real branch and head, so only the author check stops it.
    const forgeries: Pick<StoredComment, "author" | "authorType">[] = [
      { author: "mallory", authorType: "User" },
      { author: "other-app[bot]", authorType: "Bot" },
      // GitHub logins cannot hold brackets, but the type check does not rely on that.
      { author: SELF, authorType: "User" },
    ];
    for (const forgery of forgeries) {
      const forged: StoredComment[] = comments.map((comment) => ({ ...comment, ...forgery, id: comment.id + 1 }));
      const memory = memoryGitHub({ self: SELF, remote: repo.remote, comments: forged });

      const outcome = await runCommand(command("approve"), { github: memory.github, retry: noRetry, botLogin: SELF });

      expect(outcome).toEqual({ status: "refused", reason: "No run on #7 waits for approval." });
      expect(memory.calls.some((call) => call.op === "openDraft" || call.op === "updatePull")).toBe(false);
      expect(reactions(memory.calls)).toEqual(["eyes", "confused"]);
      expect(memory.calls.find((call) => call.op === "createComment")).toMatchObject({ issue: 7, body: "No run on #7 waits for approval." });
    }
  });

  it("reads the stored run only under the bot login the entry point passes", async () => {
    const { repo, comments } = await awaitingRun();
    const memory = memoryGitHub({ self: SELF, remote: repo.remote, comments });

    const outcome = await runCommand(command("approve"), { github: memory.github, retry: noRetry, botLogin: "github-actions[bot]" });

    expect(outcome.status).toBe("refused");
    expect(memory.calls.some((call) => call.op === "openDraft")).toBe(false);
  });

  it("refuses with the reason when the branch moved after the gate measured it", async () => {
    const { repo, comments } = await awaitingRun();
    const moved = pushOther(repo.remote);
    const memory = memoryGitHub({ self: SELF, remote: repo.remote, comments });

    const outcome = await runCommand(command("approve"), { github: memory.github, retry: noRetry, botLogin: SELF });

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toMatch(new RegExp(`^\`thin-pr/7\` now points at ${moved.slice(0, 7)}`));
    expect(memory.calls.some((call) => call.op === "openDraft")).toBe(false);
    expect(reactions(memory.calls)).toEqual(["eyes", "confused"]);
  });

  it("acts on the issue a thin-pr draft belongs to when the command is on the pull request", async () => {
    const { repo, comments } = await awaitingRun();
    const memory = memoryGitHub({ self: SELF, remote: repo.remote, comments, pulls: { 12: { branch: "thin-pr/7" } } });

    const outcome = await runCommand(command("approve", { number: 12, pull: true }), { github: memory.github, retry: noRetry, botLogin: SELF });

    expect(outcome.status).toBe("approved");
    expect(memory.calls.find((call) => call.op === "listComments")).toMatchObject({ issue: 7 });

    const other = memoryGitHub({ self: SELF, pulls: { 13: { branch: "feature/flag" } } });
    const refused = await runCommand(command("approve", { number: 13, pull: true }), { github: other.github, retry: noRetry, botLogin: SELF });
    expect(refused).toEqual({ status: "refused", reason: "This pull request is not a thin-pr draft, so there is no run to act on." });
  });
});

describe("/thin-pr cancel", () => {
  it("deletes the waiting run's branch and ends its comment as cancelled", async () => {
    const { repo, comments } = await awaitingRun();
    const memory = memoryGitHub({ self: SELF, remote: repo.remote, comments });

    const outcome = await runCommand(command("cancel"), { github: memory.github, retry: noRetry, botLogin: SELF });

    expect(outcome).toEqual({ status: "cancelled", detail: "thin-pr/7" });
    expect(git(repo.remote, "branch", "--list", "thin-pr/7")).toBe("");
    expect(reactions(memory.calls)).toEqual(["eyes", "+1"]);
    const runComment = memory.comments.find((comment) => comment.author === SELF);
    expect(runComment?.body.split("\n")[0]).toBe(
      "**Cancelled.** octocat cancelled the run before approval. `thin-pr/7` is deleted, and no draft is open.",
    );
    const approve = await runCommand(command("approve"), { github: memoryGitHub({ self: SELF, comments: memory.comments }).github, retry: noRetry, botLogin: SELF });
    expect(approve.status).toBe("refused");
  });

  it("keeps a branch that moved after the run, and says so", async () => {
    const { repo, comments } = await awaitingRun();
    const moved = pushOther(repo.remote);
    const memory = memoryGitHub({ self: SELF, remote: repo.remote, comments });

    const outcome = await runCommand(command("cancel"), { github: memory.github, retry: noRetry, botLogin: SELF });

    expect(outcome.status).toBe("refused");
    expect(git(repo.remote, "rev-parse", "thin-pr/7")).toBe(moved);
    expect(memory.calls.some((call) => call.op === "deleteBranch")).toBe(false);
  });

  it("refuses when nothing waits for approval", async () => {
    const memory = memoryGitHub({ self: SELF });
    expect(await runCommand(command("cancel"), { github: memory.github, retry: noRetry, botLogin: SELF })).toEqual({
      status: "refused",
      reason: "No run on #7 waits for approval.",
    });
  });
});

describe("/thin-pr retry", () => {
  it("starts a fresh run with the issue's thin-pr label", async () => {
    const memory = memoryGitHub({ self: SELF });
    const started: LabelEvent[] = [];
    const retry = async (event: LabelEvent): Promise<LabelRunResult> => {
      started.push(event);
      return { status: "ignored" };
    };

    const ignored = await runCommand(command("retry", { labels: ["bug", "thin-pr:nope"] }), { github: memory.github, retry, botLogin: SELF });
    expect(ignored).toEqual({ status: "refused", reason: "No template has the label `thin-pr:nope`." });
    expect(started.map((event) => [event.label, event.issue.number, event.issueText])).toEqual([
      ["thin-pr:nope", 7, "#7 Sample thin pull request"],
    ]);

    const unlabeled = await runCommand(command("retry", { labels: ["bug"] }), { github: memory.github, retry, botLogin: SELF });
    expect(unlabeled.status).toBe("refused");
    expect(started).toHaveLength(1);
  });

  it("reports the new run, and reads the issue first when the command is on its draft", async () => {
    const opened: LabelRunResult = { status: "blocked", record: {} as never, error: "gate failed: tests" };
    const memory = memoryGitHub({
      self: SELF,
      pulls: { 12: { branch: "thin-pr/7" } },
      issues: { 7: { number: 7, title: "Sample thin pull request", body: "Fix it.", labels: ["thin-pr:bugfix"] } },
    });
    const started: LabelEvent[] = [];
    const outcome = await runCommand(command("retry", { number: 12, pull: true, labels: [] }), {
      github: memory.github,
      botLogin: SELF,
      retry: async (event) => {
        started.push(event);
        return opened;
      },
    });

    expect(outcome).toEqual({ status: "retried", run: opened });
    expect(started.map((event) => [event.label, event.issue.number, event.issueText])).toEqual([
      ["thin-pr:bugfix", 7, "#7 Sample thin pull request\n\nFix it."],
    ]);
    expect(reactions(memory.calls)).toEqual(["eyes", "+1"]);
  });
});

describe("unknown commands", () => {
  it("answers with the help text", async () => {
    const memory = memoryGitHub({ self: SELF });
    expect(await runCommand(command("help"), { github: memory.github, retry: noRetry, botLogin: SELF })).toEqual({ status: "helped", detail: "help" });
    expect(memory.calls.find((call) => call.op === "createComment")).toMatchObject({ issue: 7, body: HELP });
    expect(reactions(memory.calls)).toEqual(["eyes"]);
  });
});

/** Pushes an unrelated commit to `thin-pr/7` and returns its sha. */
function pushOther(remote: string): string {
  const parent = mkdtempSync(join(tmpdir(), "thin-pr-clone-"));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  const dir = join(parent, "checkout");
  git(parent, "clone", "--quiet", remote, dir);
  git(dir, "config", "user.name", "thin-pr");
  git(dir, "config", "user.email", "thin-pr@localhost");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# Sample\n");
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--message", "Move the branch");
  git(dir, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/thin-pr/7");
  return git(dir, "rev-parse", "HEAD");
}
