import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ReplayModelClient, type ModelClient } from "@thin-pr/specialists";
import { runAction, type LabelRunResult } from "./index.js";
import type { GitHubSurface } from "./surface.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const fixturePath = fileURLToPath(new URL("../../../fixtures/sample-issue-labeled.json", import.meta.url));
const directories: string[] = [];

type Payload = {
  action: string;
  label: { name: string };
  issue: { number: number; title: string; body: string | null };
  repository: { name: string; default_branch: string; owner: { login: string } };
};

type Call = {
  readonly op: "branchSha" | "createBranch" | "advanceBranch" | "startCheck" | "finishCheck" | "comment" | "openDraft";
  readonly owner: string;
  readonly repo: string;
  readonly branch?: string;
  readonly sha?: string;
  readonly message?: string;
  readonly name?: string;
  readonly checkRunId?: number;
  readonly conclusion?: "success" | "failure";
  readonly summary?: string;
  readonly title?: string;
  readonly issue?: number;
  readonly body?: string;
  readonly head?: string;
  readonly base?: string;
  readonly draft?: true;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("issue label", () => {
  it("opens a draft pull request when every gate rule passes", async () => {
    const memory = memoryGitHub();
    const result = await runSample(memory.github, readFixture(), { model: modelFromFixture("gate-pass.json") });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") {
      return;
    }
    expect(result.branch).toBe("thin-pr/7");
    expect(result.headSha).toBe("def456");
    expect(result.pullRequest).toEqual({
      number: 11,
      url: "https://github.com/example/sample-repo/pull/11",
    });
    expect(result.checks.map((check) => [check.step, check.conclusion])).toEqual([
      ["plan", "success"],
      ["implement", "success"],
      ["test", "success"],
      ["review", "success"],
      ["gate/plan", "success"],
      ["gate/tests", "success"],
      ["gate/contracts", "success"],
      ["gate", "success"],
    ]);
    expect(memory.calls.map((call) => call.op)).toEqual([
      "branchSha",
      "createBranch",
      "advanceBranch",
      "startCheck",
      "finishCheck",
      "startCheck",
      "finishCheck",
      "startCheck",
      "finishCheck",
      "startCheck",
      "finishCheck",
      "startCheck",
      "startCheck",
      "finishCheck",
      "startCheck",
      "finishCheck",
      "startCheck",
      "finishCheck",
      "finishCheck",
      "openDraft",
    ]);
    expect(memory.calls[0]).toMatchObject({ op: "branchSha", owner: "example", repo: "sample-repo", branch: "main" });
    expect(memory.calls[1]).toMatchObject({
      op: "createBranch",
      owner: "example",
      repo: "sample-repo",
      branch: "thin-pr/7",
      sha: "abc123",
    });
    expect(memory.calls[2]).toMatchObject({
      op: "advanceBranch",
      branch: "thin-pr/7",
      sha: "abc123",
      message: "Prepare thin-pr/#7",
    });
    expect(memory.calls.filter((call) => call.op === "startCheck").map((call) => call.name)).toEqual([
      "thin-pr / plan",
      "thin-pr / implement",
      "thin-pr / test",
      "thin-pr / review",
      "thin-pr / gate",
      "thin-pr / gate / plan",
      "thin-pr / gate / tests",
      "thin-pr / gate / contracts",
    ]);
    expect(memory.calls.filter((call) => call.op === "startCheck").every((call) => call.sha === "def456")).toBe(true);
    const ruleChecks = memory.calls.filter((call) => call.op === "finishCheck" && call.title === "PASS");
    expect(ruleChecks.map((call) => call.summary)).toEqual([
      "PASS: Plan is present (1 step).",
      "PASS: Tests passed.",
      "PASS: Specialist outputs match their contracts.",
    ]);
    expect(memory.calls.some((call) => call.op === "comment")).toBe(false);
    const draft = memory.calls.find((call) => call.op === "openDraft");
    expect(draft).toMatchObject({
      owner: "example",
      repo: "sample-repo",
      title: "Fix the stub",
      head: "thin-pr/7",
      base: "main",
      draft: true,
    });
    expect(draft?.body).toContain("## Plan");
    expect(draft?.body).toContain("Plan the stub change.");
    expect(draft?.body).toContain("- edit the stub");
    expect(draft?.body).toContain("## Test results");
    expect(draft?.body).toContain("Stub checks passed.");
    expect(draft?.body).toContain("Tests passed.");
    expect(draft?.body).toContain("## Run report");
    expect(draft?.body).toContain("Run: run-7");
    expect(draft?.body).toContain("Branch: thin-pr/7");
    expect(draft?.body).toContain("PASS: Plan is present (1 step).");
    expect(draft?.body).not.toContain("- Error:");
  });

  it("does not open a pull request when a gate rule fails", async () => {
    const memory = memoryGitHub();
    const result = await runSample(memory.github, readFixture(), { model: modelFromFixture("gate-fail.json") });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      return;
    }
    expect(result.branch).toBe("thin-pr/7");
    expect(result.report.error).toContain("gate decide returned fail");
    expect(result.report.steps.map((step) => [step.step, step.conclusion])).toEqual([
      ["plan", "success"],
      ["implement", "success"],
      ["test", "success"],
      ["review", "success"],
      ["gate/plan", "success"],
      ["gate/tests", "failure"],
      ["gate/contracts", "success"],
      ["gate", "failure"],
    ]);
    expect(memory.calls.some((call) => call.op === "openDraft")).toBe(false);
    const failedRule = memory.calls.find((call) => call.summary === "FAIL: Tests did not pass.");
    expect(failedRule).toMatchObject({ op: "finishCheck", conclusion: "failure", title: "FAIL" });
    const comment = memory.calls.find((call) => call.op === "comment");
    expect(comment).toMatchObject({ issue: 7, owner: "example", repo: "sample-repo" });
    expect(comment?.body).toContain("## Run report");
    expect(comment?.body).toContain("- Error: gate decide returned fail");
    expect(comment?.body).toContain("PASS: Plan is present (1 step).");
    expect(comment?.body).toContain("- gate/tests: failure. FAIL: Tests did not pass.");
    expect(comment?.body).toContain("PASS: Specialist outputs match their contracts.");
  });

  it("comments the run report when a step fails", async () => {
    const memory = memoryGitHub();
    const result = await runSample(memory.github, readFixture(), { gates: { decide: () => "fail" } });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      return;
    }
    expect(result.branch).toBe("thin-pr/7");
    expect(result.report.error).toContain("gate decide returned fail");
    expect(result.report.steps.map((step) => [step.step, step.conclusion])).toEqual([
      ["plan", "success"],
      ["implement", "success"],
      ["test", "success"],
      ["review", "success"],
      ["gate", "failure"],
    ]);
    const comment = memory.calls.find((call) => call.op === "comment");
    expect(comment).toMatchObject({ issue: 7, owner: "example", repo: "sample-repo" });
    expect(comment?.body).toContain("## Run report");
    expect(comment?.body).toContain("Run: run-7");
    expect(comment?.body).toContain("Template: small-feature");
    expect(comment?.body).toContain("Branch: thin-pr/7");
    expect(comment?.body).toContain("gate decide returned fail");
    expect(comment?.body).toContain("- gate: failure.");
    const gateFinish = memory.calls.find((call) => call.op === "finishCheck" && call.conclusion === "failure");
    expect(gateFinish?.summary).toContain("gate decide returned fail");
    expect(memory.calls.some((call) => call.op === "openDraft")).toBe(false);
  });

  it("comments the run report when the branch cannot be created", async () => {
    const memory = memoryGitHub({ failCreate: true });
    const result = await runSample(memory.github, readFixture());

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      return;
    }
    expect(result.report.steps).toEqual([]);
    expect(result.report.error).toBe("branch already exists");
    const comment = memory.calls.find((call) => call.op === "comment");
    expect(comment?.body).toContain("## Run report");
    expect(comment?.body).toContain("branch already exists");
    expect(comment?.body).toContain("No step finished.");
    expect(memory.calls.some((call) => call.op === "startCheck")).toBe(false);
    expect(memory.calls.some((call) => call.op === "openDraft")).toBe(false);
  });

  it("ignores a label other than thin-pr", async () => {
    const memory = memoryGitHub();
    const payload = readFixture();
    payload.label.name = "bug";
    const result = await runSample(memory.github, payload);

    expect(result).toEqual({ status: "ignored" });
    expect(memory.calls).toEqual([]);
  });

  it("points the workflow at the label and the action entry", () => {
    const workflow = readFileSync(join(root, ".github/workflows/thin-pr.yml"), "utf8");
    expect(workflow).toContain("types: [labeled]");
    expect(workflow).toContain("github.event.label.name == 'thin-pr'");
    expect(workflow).toContain("packages/github/src/action.ts");
    expect(workflow).toContain("checks: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("pull-requests: write");
  });

  it("keeps GitHub clients inside packages/github", () => {
    const hits: string[] = [];
    for (const name of ["core", "specialists", "gate"]) {
      for (const file of typescriptFiles(join(root, "packages", name))) {
        for (const specifier of specifiers(readFileSync(file, "utf8"))) {
          if (isGitHubClient(specifier)) {
            hits.push(`${file}: ${specifier}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);

    const action = readFileSync(fileURLToPath(new URL("./action.ts", import.meta.url)), "utf8");
    expect(action).toContain("@octokit/rest");
    expect(action).toContain("@actions/core");
    expect(action).toContain("@actions/github");
    for (const name of ["action.ts", "run.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
      expect(source).not.toContain("pulls");
    }
    const surface = readFileSync(fileURLToPath(new URL("./surface.ts", import.meta.url)), "utf8");
    expect(surface).toContain("pulls");
    expect(surface).toContain("draft: true");
  });
});

function readFixture(): Payload {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Payload;
}

function modelFromFixture(name: string): ModelClient {
  const fixture = JSON.parse(readFileSync(join(root, "fixtures", name), "utf8")) as {
    plan: unknown;
    implement: unknown;
    test: unknown;
    review: unknown;
    pullRequest: unknown;
  };
  return new ReplayModelClient({
    planner: JSON.stringify(fixture.plan),
    implementer: JSON.stringify(fixture.implement),
    tester: JSON.stringify(fixture.test),
    reviewer: JSON.stringify(fixture.review),
    "pr-writer": JSON.stringify(fixture.pullRequest),
  });
}

async function runSample(
  github: GitHubSurface,
  payload: Payload,
  options?: {
    readonly gates?: { decide: () => "fail" };
    readonly model?: ModelClient;
  },
): Promise<LabelRunResult> {
  const directory = mkdtempSync(join(tmpdir(), "thin-pr-label-"));
  directories.push(directory);
  return runAction({
    payload,
    workspace: root,
    runId: "run-7",
    logPath: join(directory, "events.sqlite"),
    github,
    gates: options?.gates,
    model: options?.model,
  });
}

function memoryGitHub(options?: { readonly failCreate?: boolean }) {
  const calls: Call[] = [];
  let nextId = 1;
  const github: GitHubSurface = {
    async branchSha(owner, repo, branch) {
      calls.push({ op: "branchSha", owner, repo, branch });
      return "abc123";
    },
    async createBranch(owner, repo, branch, sha) {
      calls.push({ op: "createBranch", owner, repo, branch, sha });
      if (options?.failCreate) {
        throw new Error("branch already exists");
      }
    },
    async startCheck(input) {
      calls.push({ op: "startCheck", owner: input.owner, repo: input.repo, name: input.name, sha: input.sha });
      const id = nextId;
      nextId += 1;
      return id;
    },
    async finishCheck(input) {
      calls.push({
        op: "finishCheck",
        owner: input.owner,
        repo: input.repo,
        checkRunId: input.checkRunId,
        conclusion: input.conclusion,
        summary: input.summary,
        title: input.title,
      });
    },
    async comment(input) {
      calls.push({ op: "comment", owner: input.owner, repo: input.repo, issue: input.issue, body: input.body });
    },
    async advanceBranch(input) {
      calls.push({
        op: "advanceBranch",
        owner: input.owner,
        repo: input.repo,
        branch: input.branch,
        sha: input.sha,
        message: input.message,
      });
      return "def456";
    },
    async openDraft(input) {
      calls.push({
        op: "openDraft",
        owner: input.owner,
        repo: input.repo,
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        draft: input.draft,
      });
      return { number: 11, url: `https://github.com/${input.owner}/${input.repo}/pull/11` };
    },
  };
  return { github, calls };
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) {
        found.push(specifier);
      }
    }
  }
  return found;
}

function isGitHubClient(specifier: string): boolean {
  const name = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : (specifier.split("/")[0] ?? specifier);
  return name === "@thin-pr/github" || name.startsWith("@octokit/") || name.startsWith("@actions/");
}

function typescriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...typescriptFiles(path));
      continue;
    }
    if (entry.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}
