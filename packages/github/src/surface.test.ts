import { describe, expect, it } from "vitest";
import { createGitHubSurface, type GitHubRest } from "./surface.js";

describe("Octokit surface", () => {
  it("maps check, comment, and pull request calls onto the REST client", async () => {
    const calls: unknown[] = [];
    const pull = { number: 11, html_url: "https://github.com/example/sample-repo/pull/11" };
    const base = restWith(calls, {});
    const octokit: GitHubRest = {
      ...base,
      pulls: {
        ...base.pulls,
        async create(params) {
          calls.push(["pulls.create", params]);
          return { data: pull };
        },
        async list(params) {
          calls.push(["pulls.list", params]);
          return { data: [pull] };
        },
        async update(params) {
          calls.push(["pulls.update", params]);
          return { data: pull };
        },
      },
      checks: {
        async create(params) {
          calls.push(["checks.create", params]);
          return { data: { id: 42 } };
        },
        async update(params) {
          calls.push(["checks.update", params]);
        },
      },
      git: {
        ...base.git,
        async getRef(params) {
          calls.push(["git.getRef", params]);
          if (params.ref === "heads/thin-pr/7") {
            return { data: { object: { sha: "sha-7" } } };
          }
          throw Object.assign(new Error("Not Found"), { status: 404 });
        },
      },
      issues: {
        ...base.issues,
        async createComment(params) {
          calls.push(["issues.createComment", params]);
          return { data: { id: 99 } };
        },
        async updateComment(params) {
          calls.push(["issues.updateComment", params]);
        },
      },
    };
    const github = createGitHubSurface(octokit);
    const target = { owner: "example", repo: "sample-repo" };

    await expect(github.startCheck({ ...target, name: "thin-pr / plan", sha: "sha-1" })).resolves.toBe(42);
    await github.finishCheck({ ...target, checkRunId: 42, conclusion: "failure", summary: "gate failed" });
    await expect(github.createComment({ ...target, issue: 7, body: "## Running" })).resolves.toBe(99);
    await github.editComment({ ...target, commentId: 99, body: "## Run report" });
    await expect(github.branchHead({ ...target, branch: "thin-pr/7" })).resolves.toBe("sha-7");
    await expect(github.branchHead({ ...target, branch: "thin-pr/8" })).resolves.toBeNull();
    await expect(github.listPullsForHead({ ...target, branch: "thin-pr/7" })).resolves.toEqual([
      { number: 11, url: pull.html_url },
    ]);
    await expect(github.updatePull({ ...target, number: 11, body: "## Plan" })).resolves.toEqual({ number: 11, url: pull.html_url });
    await expect(
      github.openDraft({ ...target, title: "Fix the stub", head: "thin-pr/7", base: "main", body: "## Plan", draft: true }),
    ).resolves.toEqual({ number: 11, url: pull.html_url });

    expect(calls).toEqual([
      [
        "checks.create",
        { ...target, name: "thin-pr / plan", head_sha: "sha-1", status: "in_progress", started_at: expect.any(String) },
      ],
      [
        "checks.update",
        {
          ...target,
          check_run_id: 42,
          status: "completed",
          conclusion: "failure",
          completed_at: expect.any(String),
          output: { title: "Failed", summary: "gate failed" },
        },
      ],
      ["issues.createComment", { ...target, issue_number: 7, body: "## Running" }],
      ["issues.updateComment", { ...target, comment_id: 99, body: "## Run report" }],
      ["git.getRef", { ...target, ref: "heads/thin-pr/7" }],
      ["git.getRef", { ...target, ref: "heads/thin-pr/8" }],
      ["pulls.list", { ...target, head: "example:thin-pr/7", state: "open" }],
      ["pulls.update", { ...target, pull_number: 11, body: "## Plan" }],
      ["pulls.create", { ...target, title: "Fix the stub", head: "thin-pr/7", base: "main", body: "## Plan", draft: true }],
    ]);
  });

  it("maps the calls commands make, and pages through comments", async () => {
    const calls: unknown[] = [];
    const page = (from: number, size: number) =>
      Array.from({ length: size }, (_, index) => ({ id: from + index, body: `comment ${from + index}`, user: { login: "octocat" } }));
    const octokit = restWith(calls, {
      issues: {
        async listComments(params) {
          calls.push(["issues.listComments", params]);
          return { data: params.page === 1 ? page(1, 100) : [{ id: 101, user: null }] };
        },
        async get(params) {
          calls.push(["issues.get", params]);
          return { data: { number: 7, title: "Add a flag", body: null, labels: ["thin-pr", { name: "bug" }, {}] } };
        },
      },
    });
    const github = createGitHubSurface(octokit);
    const target = { owner: "example", repo: "sample-repo" };

    const comments = await github.listComments({ ...target, issue: 7 });
    expect(comments).toHaveLength(101);
    expect(comments.at(-1)).toEqual({ id: 101, author: null, body: "" });
    await expect(github.react({ ...target, commentId: 5, content: "eyes" })).resolves.toBe("thin-pr[bot]");
    await expect(github.getIssue({ ...target, issue: 7 })).resolves.toEqual({
      number: 7,
      title: "Add a flag",
      body: "",
      labels: ["thin-pr", "bug"],
    });
    await expect(github.getPull({ ...target, number: 11 })).resolves.toEqual({
      number: 11,
      open: true,
      branch: "thin-pr/7",
      sameRepo: true,
    });
    await github.deleteBranch({ ...target, branch: "thin-pr/7" });

    expect(calls).toEqual([
      ["issues.listComments", { ...target, issue_number: 7, per_page: 100, page: 1 }],
      ["issues.listComments", { ...target, issue_number: 7, per_page: 100, page: 2 }],
      ["reactions.createForIssueComment", { ...target, comment_id: 5, content: "eyes" }],
      ["issues.get", { ...target, issue_number: 7 }],
      ["pulls.get", { ...target, pull_number: 11 }],
      ["git.deleteRef", { ...target, ref: "heads/thin-pr/7" }],
    ]);
  });
});

/** A REST client whose every method records its call. `overrides` replaces methods per namespace. */
function restWith(calls: unknown[], overrides: { readonly issues?: Partial<GitHubRest["issues"]> }): GitHubRest {
  const unused = async (): Promise<never> => {
    throw new Error("not used in this test");
  };
  return {
    pulls: {
      create: unused,
      list: unused,
      update: unused,
      async get(params) {
        calls.push(["pulls.get", params]);
        return {
          data: {
            number: 11,
            state: "open",
            head: { ref: "thin-pr/7", repo: { full_name: "example/sample-repo" } },
            base: { repo: { full_name: "example/sample-repo" } },
          },
        };
      },
    },
    checks: { create: unused, update: unused },
    git: {
      getRef: unused,
      async deleteRef(params) {
        calls.push(["git.deleteRef", params]);
      },
    },
    reactions: {
      async createForIssueComment(params) {
        calls.push(["reactions.createForIssueComment", params]);
        return { data: { user: { login: "thin-pr[bot]" } } };
      },
    },
    issues: { createComment: unused, updateComment: unused, listComments: unused, get: unused, ...overrides.issues },
  };
}
