import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ReplayModelClient, type ModelClient } from "@thin-pr/specialists";
import { createScratchRepo } from "@thin-pr/workspace";
import { runAction, type LabelRunResult } from "./run.js";
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

describe("issue label", () => {
  it("pushes the branch and opens a draft when every gate rule passes", async () => {
    const repo = scratch(PASSING_CHECKS);
    const memory = memoryGitHub();
    const result = await run(repo, memory.github, { model: modelFromFixture("gate-pass.json") });

    expect(result.status).toBe("opened");
    if (result.status !== "opened") {
      return;
    }
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
    expect(memory.calls.at(-2)).toMatchObject({ op: "listPullsForHead", branch: "thin-pr/7" });
    const draft = memory.calls.at(-1);
    expect(draft).toMatchObject({ op: "openDraft", title: "Fix the stub", head: "thin-pr/7", base: "main", draft: true });
    expect(draft?.body).toContain("## Plan\n\nPlan the stub change.\n\n- edit the stub");
    expect(draft?.body).toContain("## Checks\n\n- typecheck: exit 0 in ");
    expect(draft?.body).toContain("- verify: success. typecheck passed; test passed.");
    expect(draft?.body).toContain("- gate/secrets: success. PASS: No added line looks like a secret.");
    expect(memory.calls.some((call) => call.op === "comment")).toBe(false);
  });

  it("comments the run report and pushes nothing when a gate rule fails", async () => {
    const repo = scratch(PASSING_CHECKS);
    const memory = memoryGitHub();
    const result = await run(repo, memory.github, { model: modelFromFixture("gate-fail.json") });

    expect(result).toMatchObject({ status: "blocked", error: "gate failed: review" });
    expect(git(repo.remote, "branch", "--list", "thin-pr/7")).toBe("");
    expect(memory.calls.some((call) => call.op === "openDraft" || call.op === "listPullsForHead")).toBe(false);
    const ruleChecks = memory.calls.filter((call) => call.op === "startCheck" && String(call.name).includes("/ gate /"));
    expect(ruleChecks.every((call) => call.sha === repo.baseSha)).toBe(true);
    const comment = memory.calls.find((call) => call.op === "comment");
    expect(comment).toMatchObject({ issue: 7, owner: "example", repo: "sample-repo" });
    expect(comment?.body).toContain("- Error: gate failed: review");
    expect(comment?.body).toContain("- gate/review: failure. FAIL: Reviewer left 1 note.");
  });

  it("loops verify back to implement on a failing test, then blocks on the tests rule", async () => {
    const repo = scratch("checks:\n  typecheck: 'true'\n  test: echo '1 failed'; exit 1\n");
    const memory = memoryGitHub();
    const result = await run(repo, memory.github, { model: modelFromFixture("gate-pass.json") });

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
  });

  it("installs once before verify and fails the run when the install fails", async () => {
    const repo = scratch(`install: echo 'lockfile is out of date'; exit 3\n${PASSING_CHECKS}`);
    const memory = memoryGitHub();
    const result = await run(repo, memory.github, { model: modelFromFixture("gate-pass.json") });

    expect(result).toMatchObject({
      status: "failed",
      error: "verify failed after 1 attempt: install failed (exit 3): echo 'lockfile is out of date'; exit 3\nlockfile is out of date\n",
    });
    expect(git(repo.remote, "branch", "--list", "thin-pr/7")).toBe("");
  });

  it("blocks a run whose implementer changed nothing", async () => {
    const repo = scratch(PASSING_CHECKS);
    const memory = memoryGitHub();
    const result = await run(repo, memory.github, { model: new ReplayModelClient() });

    expect(result).toMatchObject({ status: "blocked", error: "gate failed: diff" });
    expect(memory.calls.find((call) => call.op === "comment")?.body).toContain("FAIL: Diff is empty.");
  });

  it("comments the run report when a step fails", async () => {
    const repo = scratch(PASSING_CHECKS);
    const memory = memoryGitHub();
    const result = await run(repo, memory.github, {
      model: new ReplayModelClient({ planner: JSON.stringify({ summary: 1, steps: ["edit the stub"] }) }),
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
    const comment = memory.calls.find((call) => call.op === "comment");
    expect(comment?.body).toContain("- Error: plan failed after 2 attempts");
    expect(comment?.body).toContain("- plan: failure. planner output invalid at summary");
    expect(memory.calls.some((call) => call.op === "openDraft")).toBe(false);
  });

  it("resets the branch from the fresh base and updates the open draft when the label is added again", async () => {
    const repo = scratch(PASSING_CHECKS);
    const first = memoryGitHub();
    expect((await run(repo, first.github, { model: modelFromFixture("gate-pass.json") })).status).toBe("opened");
    const firstHead = git(repo.remote, "rev-parse", "thin-pr/7");

    // The default branch moves on. The next run starts from a fresh clone, as actions/checkout gives it.
    const clone = cloneAndCommit(repo.remote, "README.md", "# Sample\n");
    const second = memoryGitHub({ openPull: { number: 11, url: "https://github.com/example/sample-repo/pull/11" } });
    const result = await run(clone, second.github, { model: modelFromFixture("gate-pass.json") });

    expect(result.status).toBe("opened");
    expect(git(repo.remote, "rev-parse", "thin-pr/7^")).toBe(clone.baseSha);
    expect(git(repo.remote, "rev-parse", "thin-pr/7")).not.toBe(firstHead);
    expect(git(repo.remote, "rev-list", "--count", "main..thin-pr/7")).toBe("1");
    expect(second.calls.some((call) => call.op === "openDraft")).toBe(false);
    expect(second.calls.at(-1)).toMatchObject({ op: "updatePull", number: 11 });
    expect(second.calls.at(-1)?.body).toContain("## Run report");
  });

  it("ignores a label other than thin-pr", async () => {
    const repo = scratch(PASSING_CHECKS);
    const memory = memoryGitHub();
    const payload = { ...readFixture(), label: { name: "bug" } };
    const result = await run(repo, memory.github, { payload });

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
    expect(readFileSync(fileURLToPath(new URL("./action.ts", import.meta.url)), "utf8")).toContain("pushToken: token");
    expect(workflow).toContain("GIT_AUTHOR_NAME: thin-pr[bot]");
    expect(workflow).toContain("GIT_COMMITTER_EMAIL: thin-pr@example.invalid");
    expect(workflow).toContain("THIN_PR_MODEL:");
    expect(workflow).toContain("|| 'replay'");
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

function readFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "fixtures", "sample-issue-labeled.json"), "utf8")) as Record<string, unknown>;
}

function modelFromFixture(name: string): ModelClient {
  const fixture = JSON.parse(readFileSync(join(root, "fixtures", name), "utf8")) as Record<string, unknown>;
  return new ReplayModelClient({
    planner: JSON.stringify(fixture.plan),
    implementer: JSON.stringify(fixture.implement),
    reviewer: JSON.stringify(fixture.review),
    "pr-writer": JSON.stringify(fixture.pullRequest),
  });
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
  options: { readonly model?: ModelClient; readonly payload?: unknown },
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
    model: options.model,
  });
}

function memoryGitHub(options?: { readonly openPull?: { readonly number: number; readonly url: string } }) {
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
    async comment(input) {
      calls.push({ op: "comment", ...input });
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
