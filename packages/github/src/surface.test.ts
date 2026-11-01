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
        async getCommit(params) {
          calls.push(["getCommit", params]);
          return { data: { tree: { sha: "tree-1" } } };
        },
        async createBlob(params) {
          calls.push(["createBlob", params]);
          return { data: { sha: "blob-1" } };
        },
        async createTree(params) {
          calls.push(["createTree", params]);
          return { data: { sha: "tree-2" } };
        },
        async createCommit(params) {
          calls.push(["createCommit", params]);
          return { data: { sha: "sha-2" } };
        },
        async updateRef(params) {
          calls.push(["updateRef", params]);
        },
      },
      pulls: {
        async create(params) {
          calls.push(["pulls.create", params]);
          return { data: { number: 11, html_url: "https://github.com/example/sample-repo/pull/11" } };
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
      repos: {
        async getContent(params) {
          calls.push(["getContent", params]);
          return { data: { type: "file", encoding: "base64", content: Buffer.from("export const stub = 1;\n").toString("base64") } };
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
    await expect(github.readText({ owner: "example", repo: "sample-repo", ref: "sha-1", path: "src/stub.ts" })).resolves.toBe(
      "export const stub = 1;\n",
    );
    await expect(
      github.commitFiles({
        owner: "example",
        repo: "sample-repo",
        branch: "thin-pr/7",
        parentSha: "sha-1",
        message: "Apply thin-pr/#7",
        files: [{ path: "src/stub.ts", content: "export const stub = 2;\n" }],
      }),
    ).resolves.toBe("sha-2");
    await expect(
      github.openDraft({
        owner: "example",
        repo: "sample-repo",
        title: "Fix the stub",
        head: "thin-pr/7",
        base: "main",
        body: "## Plan",
        draft: true,
      }),
    ).resolves.toEqual({ number: 11, url: "https://github.com/example/sample-repo/pull/11" });
    await github.finishCheck({
      owner: "example",
      repo: "sample-repo",
      checkRunId: 42,
      conclusion: "success",
      summary: "PASS: Tests passed.",
      title: "PASS",
    });

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
    expect(calls[5]).toEqual([
      "getContent",
      { owner: "example", repo: "sample-repo", path: "src/stub.ts", ref: "sha-1" },
    ]);
    expect(calls[6]).toEqual([
      "getCommit",
      { owner: "example", repo: "sample-repo", commit_sha: "sha-1" },
    ]);
    expect(calls[7]).toEqual([
      "createBlob",
      { owner: "example", repo: "sample-repo", content: "export const stub = 2;\n", encoding: "utf-8" },
    ]);
    expect(calls[8]).toEqual([
      "createTree",
      {
        owner: "example",
        repo: "sample-repo",
        base_tree: "tree-1",
        tree: [{ path: "src/stub.ts", mode: "100644", type: "blob", sha: "blob-1" }],
      },
    ]);
    expect(calls[9]).toEqual([
      "createCommit",
      {
        owner: "example",
        repo: "sample-repo",
        message: "Apply thin-pr/#7",
        tree: "tree-2",
        parents: ["sha-1"],
      },
    ]);
    expect(calls[10]).toEqual([
      "updateRef",
      { owner: "example", repo: "sample-repo", ref: "heads/thin-pr/7", sha: "sha-2" },
    ]);
    expect(calls[11]).toEqual([
      "pulls.create",
      {
        owner: "example",
        repo: "sample-repo",
        title: "Fix the stub",
        head: "thin-pr/7",
        base: "main",
        body: "## Plan",
        draft: true,
      },
    ]);
    expect(calls[12]).toMatchObject({
      0: "checks.update",
      1: {
        conclusion: "success",
        output: { title: "PASS", summary: "PASS: Tests passed." },
      },
    });
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
        async getCommit() {
          return { data: { tree: { sha: "tree-1" } } };
        },
        async createBlob() {
          return { data: { sha: "blob-1" } };
        },
        async createTree() {
          return { data: { sha: "tree-2" } };
        },
        async createCommit() {
          return { data: { sha: "sha-2" } };
        },
        async updateRef() {
          return undefined;
        },
      },
      pulls: {
        async create() {
          return { data: { number: 1, html_url: "https://github.com/example/sample-repo/pull/1" } };
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
      repos: {
        async getContent() {
          return { data: { type: "file", encoding: "base64", content: "" } };
        },
      },
    };

    await expect(createGitHubSurface(octokit).branchSha("example", "sample-repo", "main")).rejects.toThrow(
      "ref heads/main is not a commit",
    );
  });
});
