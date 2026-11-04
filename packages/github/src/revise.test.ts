import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAnthropicClient, scriptedUpstream, type Script } from "@thin-pr/specialists";
import { createScratchRepo } from "@thin-pr/workspace";
import { git, memoryGitHub, type StoredComment } from "./fake-github.js";
import { reviseMarker, runRevise, type ReviseResult } from "./revise.js";
import type { ReviseTrigger } from "./router.js";
import type { Review } from "./surface.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const SELF = "thin-pr[bot]";
const PASSING_CHECKS = "checks:\n  typecheck: echo typecheck ok\n  test: echo test ok\n";
const TRIGGER: ReviseTrigger = {
  kind: "revise",
  repo: { owner: "example", name: "sample-repo", defaultBranch: "main" },
  pull: { number: 12, branch: "thin-pr/7", issue: 7 },
  reviewId: 501,
  reviewer: "octocat",
};
const REVIEW: Review = {
  body: "Close, two small things.",
  comments: [
    { path: "src/a.ts", line: 2, body: "Return 2 here, the caller expects it." },
    { path: "src/b.ts", line: 2, body: "Name this `twice`, not `double`." },
  ],
};
const ISSUE = { number: 7, title: "Add the helpers", body: "Add a and b.", labels: ["thin-pr"] };

const SCRIPT: Script = {
  planner: [{ summary: "unused", steps: ["unused"] }],
  implementer: {
    turns: [
      [
        { name: "replace", input: { path: "src/a.ts", old_text: "return 1;", new_text: "return 2;" } },
        { name: "replace", input: { path: "src/b.ts", old_text: "const double = x * 2;\n  return double;", new_text: "const twice = x * 2;\n  return twice;" } },
      ],
    ],
    summary: "Return 2 from a and rename double to twice.",
  },
  reviewer: [{ summary: "Both comments are answered.", verdict: "approve", notes: [] }],
  "pr-writer": [{ summary: "Revision", title: "Add the helpers" }],
};

/** A remote with `thin-pr/7` one commit past main, and a checkout of that branch at its head, as the Action makes. */
function draftRepo(config: string) {
  const repo = createScratchRepo({
    "src/a.ts": "export function a(): number {\n  return 1;\n}\n",
    "src/b.ts": "export function b(x: number): number {\n  const double = x * 2;\n  return double;\n}\n",
    ".thin-pr.yml": config,
  });
  cleanups.push(() => repo.remove());
  git(repo.dir, "checkout", "--quiet", "-b", "thin-pr/7");
  writeFileSync(join(repo.dir, "src/c.ts"), "export const c = 3;\n");
  git(repo.dir, "add", "--all");
  git(repo.dir, "commit", "--quiet", "--message", "Apply thin-pr/#7");
  git(repo.dir, "push", "--quiet", "origin", "thin-pr/7");
  return { ...repo, head: git(repo.dir, "rev-parse", "HEAD") };
}

/** A scripted model that keeps every request body, so a test can read what each step was asked. */
function recorded(script: Script) {
  const requests: string[] = [];
  const upstream = scriptedUpstream(script);
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push(String(init?.body));
    return upstream(url, init);
  };
  return { session: createAnthropicClient({ mode: "live", apiKey: "test-key", fetch }, {}), requests };
}

async function revise(
  checkout: { readonly dir: string; readonly remote: string },
  options: { readonly script?: Script; readonly comments?: readonly StoredComment[] } = {},
): Promise<{ readonly result: ReviseResult; readonly memory: ReturnType<typeof memoryGitHub>; readonly requests: string[] }> {
  const memory = memoryGitHub({
    self: SELF,
    remote: checkout.remote,
    comments: options.comments,
    issues: { 7: ISSUE },
    reviews: { 501: REVIEW },
  });
  const model = recorded(options.script ?? SCRIPT);
  const directory = mkdtempSync(join(tmpdir(), "thin-pr-revise-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const result = await runRevise({
    trigger: TRIGGER,
    templates: join(root, "templates"),
    checkout: checkout.dir,
    baseSha: "HEAD",
    runId: "run-12",
    logPath: join(directory, "events.sqlite"),
    github: memory.github,
    botLogin: SELF,
    model: () => model.session,
  });
  return { result, memory, requests: model.requests };
}

/** The reply's bodies in order: created once, then each edit. */
function replies(memory: ReturnType<typeof memoryGitHub>): string[] {
  return memory.calls.filter((call) => call.op === "createComment" || call.op === "editComment").map((call) => String(call.body));
}

describe("revise", () => {
  it("answers a review with two inline comments: one commit on the branch and one reply that it edits", async () => {
    const repo = draftRepo(PASSING_CHECKS);

    const { result, memory, requests } = await revise(repo);

    expect(result.status).toBe("pushed");
    if (result.status !== "pushed") {
      return;
    }
    // One new commit on top of the draft, holding both answers.
    expect(git(repo.remote, "rev-parse", "thin-pr/7")).toBe(result.head);
    expect(git(repo.remote, "rev-parse", "thin-pr/7^")).toBe(repo.head);
    expect(git(repo.remote, "log", "-1", "--format=%s", "thin-pr/7")).toBe("Revise thin-pr/#7 for review 501");
    expect(git(repo.remote, "show", "thin-pr/7:src/a.ts")).toContain("return 2;");
    expect(git(repo.remote, "show", "thin-pr/7:src/b.ts")).toContain("const twice");
    expect(result.record).toMatchObject({ template: "revise", status: "opened", issue: { number: 7 } });
    expect(result.record.diff?.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);

    // The plan is the review, so no planner request was sent. Implement got both comments with file and line.
    const implement = requests.filter((body) => body.includes('"tools"'));
    expect(requests.some((body) => body.includes('"steps"'))).toBe(false);
    const asked = String(implement[0]);
    expect(asked).toContain("Review by octocat on the draft.");
    expect(asked).toContain("Close, two small things.");
    expect(asked).toContain("src/a.ts:2:\\nReturn 2 here, the caller expects it.");
    expect(asked).toContain("src/b.ts:2:\\nName this `twice`, not `double`.");
    expect(asked).toContain("Address the comment on src/a.ts:2");

    // One reply on the pull request, edited at each step, ending with what changed for each comment.
    const created = memory.calls.filter((call) => call.op === "createComment");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ issue: 12 });
    const bodies = replies(memory);
    expect(bodies[0]?.split("\n")[0]).toMatch(/^\*\*Revising `thin-pr\/7` for the review by octocat\.\*\* Run `run-12`\./);
    expect(bodies.every((body) => body.includes(reviseMarker(501)))).toBe(true);
    const final = bodies.at(-1) ?? "";
    expect(final.split("\n")[0]).toBe(
      `**Revised.** Pushed ${result.head.slice(0, 7)} to \`thin-pr/7\` for the review by octocat. All 9 gate rules passed. Return 2 from a and rename double to twice.`,
    );
    expect(final).toContain("| `src/a.ts:2` | Return 2 here, the caller expects it. | changed, +1 -1 |");
    expect(final).toContain("| `src/b.ts:2` | Name this `twice`, not `double`. | changed, +2 -2 |");
    expect(memory.calls.some((call) => call.op === "react")).toBe(false);
    expect(memory.calls.some((call) => call.op === "openDraft" || call.op === "updatePull")).toBe(false);
    const ruleChecks = memory.calls.filter((call) => call.op === "postCheck");
    expect(ruleChecks).toHaveLength(9);
    expect(ruleChecks.every((call) => call.sha === result.head)).toBe(true);

    // The events for the two inline comments name the same review. They find the reply and do nothing.
    const again = await revise(repo, { comments: memory.comments });
    expect(again.result).toEqual({ status: "ignored", reason: "review 501 already has a reply" });
    expect(again.requests).toEqual([]);
    expect(git(repo.remote, "rev-parse", "thin-pr/7")).toBe(result.head);
  });

  it("does not take a reply marker from a user's comment or another bot's comment", async () => {
    const repo = draftRepo(PASSING_CHECKS);
    const body = `Done!\n${reviseMarker(501)}`;
    const forged: StoredComment[] = [
      { id: 1, issue: 12, author: "mallory", authorType: "User", body },
      { id: 2, issue: 12, author: "other-app[bot]", authorType: "Bot", body },
    ];

    const { result } = await revise(repo, { comments: forged });

    expect(result.status).toBe("pushed");
  });

  it("stops before a model call could pass the spend limit, explains it in the reply, and pushes nothing", async () => {
    // The implementer's request could cost 0.64 USD, so a 0.2 limit stops the run at implement.
    const repo = draftRepo(`spend_usd: 0.2\n${PASSING_CHECKS}`);

    const { result, memory } = await revise(repo);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      return;
    }
    expect(result.error).toMatch(/^implement stopped: the next model call could pass the run's spend_usd of 0\.2 USD/);
    expect(result.record.steps.map((step) => `${step.id} ${step.outcome}`)).toEqual(["plan finished", "implement failed"]);
    expect(git(repo.remote, "rev-parse", "thin-pr/7")).toBe(repo.head);
    const final = replies(memory).at(-1) ?? "";
    expect(final.split("\n")[0]).toBe("**Not revised.** Nothing was pushed to `thin-pr/7` for the review by octocat.");
    expect(final).toContain(`**Run failed.** ${result.error}`);
  });

  it("keeps to the template's loop limit when the checks keep failing, then explains the failed rule", async () => {
    // The failure text changes every pass, so the loop limit is what stops it, not a repeated failure.
    const repo = draftRepo("checks:\n  typecheck: 'true'\n  test: echo \"failed at $(date +%s%N)\"; exit 1\n");

    const { result, memory } = await revise(repo);

    expect(result).toMatchObject({ status: "blocked", error: "gate failed: tests" });
    if (result.status !== "blocked") {
      return;
    }
    // revise.yaml lets verify loop back to implement twice.
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
    expect(git(repo.remote, "rev-parse", "thin-pr/7")).toBe(repo.head);
    const final = replies(memory).at(-1) ?? "";
    expect(final).toContain("**Gate failed.** 1 of 9 rules failed: `tests`. Nothing was pushed.");
  });

  it("pushes nothing when the revision is over the budget, and says what to do instead", async () => {
    const repo = draftRepo(`budget:\n  max_lines: 1\n${PASSING_CHECKS}`);

    const { result, memory } = await revise(repo);

    expect(result.status).toBe("blocked");
    expect(git(repo.remote, "rev-parse", "thin-pr/7")).toBe(repo.head);
    const final = replies(memory).at(-1) ?? "";
    expect(final.split("\n")[0]).toMatch(/^\*\*Not revised\.\*\* Diff exceeds the budget \(2 files, 6 lines; limit 6 files, 1 line\)\. /);
    expect(final).not.toContain("/thin-pr approve");
  });

  it("ignores a review with no text and no inline comments", async () => {
    const repo = draftRepo(PASSING_CHECKS);
    const memory = memoryGitHub({ self: SELF, remote: repo.remote, issues: { 7: ISSUE }, reviews: { 501: { body: " ", comments: [] } } });
    const result = await runRevise({
      trigger: TRIGGER,
      templates: join(root, "templates"),
      checkout: repo.dir,
      baseSha: "HEAD",
      runId: "run-12",
      logPath: join(repo.dir, "..", "unused.sqlite"),
      github: memory.github,
      botLogin: SELF,
      model: () => {
        throw new Error("no model for an empty review");
      },
    });

    expect(result).toEqual({ status: "ignored", reason: "review 501 has no text to act on" });
    expect(memory.calls.some((call) => call.op === "createComment")).toBe(false);
  });
});
