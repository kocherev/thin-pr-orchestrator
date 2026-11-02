import { describe, expect, it } from "vitest";
import { createGitHubSurface, type GitHubRest } from "./surface.js";

describe("Octokit surface", () => {
  it("maps check, comment, and pull request calls onto the REST client", async () => {
    const calls: unknown[] = [];
    const pull = { number: 11, html_url: "https://github.com/example/sample-repo/pull/11" };
    const octokit: GitHubRest = {
      pulls: {
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
      issues: {
        async createComment(params) {
          calls.push(["issues.createComment", params]);
        },
      },
    };
    const github = createGitHubSurface(octokit);
    const target = { owner: "example", repo: "sample-repo" };

    await expect(github.startCheck({ ...target, name: "thin-pr / plan", sha: "sha-1" })).resolves.toBe(42);
    await github.finishCheck({ ...target, checkRunId: 42, conclusion: "failure", summary: "gate failed" });
    await github.comment({ ...target, issue: 7, body: "## Run report" });
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
      ["issues.createComment", { ...target, issue_number: 7, body: "## Run report" }],
      ["pulls.list", { ...target, head: "example:thin-pr/7", state: "open" }],
      ["pulls.update", { ...target, pull_number: 11, body: "## Plan" }],
      ["pulls.create", { ...target, title: "Fix the stub", head: "thin-pr/7", base: "main", body: "## Plan", draft: true }],
    ]);
  });
});
