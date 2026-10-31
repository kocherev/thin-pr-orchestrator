import { describe, expect, it } from "vitest";
import { createGitHubSurface, type GitHubRest } from "./surface.js";

describe("Octokit surface", () => {
  it("maps branch, check, and comment calls onto the REST client", async () => {
    const calls: unknown[] = [];
    const octokit: GitHubRest = {
      git: {
        async getRef(params) {
          calls.push(["getRef", params]);
          return { data: { object: { sha: "sha-1", type: "commit" } } };
        },
        async createRef(params) {
          calls.push(["createRef", params]);
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
      issues: {
        async createComment(params) {
          calls.push(["issues.createComment", params]);
        },
      },
    };
    const github = createGitHubSurface(octokit);

    await expect(github.branchSha("example", "sample-repo", "main")).resolves.toBe("sha-1");
    await github.createBranch("example", "sample-repo", "thin-pr/7", "sha-1");
    await expect(
      github.startCheck({ owner: "example", repo: "sample-repo", name: "thin-pr / plan", sha: "sha-1" }),
    ).resolves.toBe(42);
    await github.finishCheck({
      owner: "example",
      repo: "sample-repo",
      checkRunId: 42,
      conclusion: "failure",
      summary: "gate failed",
    });
    await github.comment({ owner: "example", repo: "sample-repo", issue: 7, body: "## Run report" });

    expect(calls[0]).toEqual(["getRef", { owner: "example", repo: "sample-repo", ref: "heads/main" }]);
    expect(calls[1]).toEqual([
      "createRef",
      { owner: "example", repo: "sample-repo", ref: "refs/heads/thin-pr/7", sha: "sha-1" },
    ]);
    expect(calls[2]).toMatchObject({
      0: "checks.create",
      1: {
        owner: "example",
        repo: "sample-repo",
        name: "thin-pr / plan",
        head_sha: "sha-1",
        status: "in_progress",
      },
    });
    expect(calls[3]).toMatchObject({
      0: "checks.update",
      1: {
        owner: "example",
        repo: "sample-repo",
        check_run_id: 42,
        status: "completed",
        conclusion: "failure",
        output: { title: "Failed", summary: "gate failed" },
      },
    });
    expect(calls[4]).toEqual([
      "issues.createComment",
      { owner: "example", repo: "sample-repo", issue_number: 7, body: "## Run report" },
    ]);
  });

  it("rejects a ref that is not a commit", async () => {
    const octokit: GitHubRest = {
      git: {
        async getRef() {
          return { data: { object: { sha: "sha-1", type: "tag" } } };
        },
        async createRef() {
          return undefined;
        },
      },
      checks: {
        async create() {
          return { data: { id: 1 } };
        },
        async update() {
          return undefined;
        },
      },
      issues: {
        async createComment() {
          return undefined;
        },
      },
    };

    await expect(createGitHubSurface(octokit).branchSha("example", "sample-repo", "main")).rejects.toThrow(
      "ref heads/main is not a commit",
    );
  });
});
