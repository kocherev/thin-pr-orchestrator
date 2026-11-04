import { describe, expect, it } from "vitest";
import { ciCheckFor } from "./ci-check.js";

const run = {
  head_branch: "thin-pr/31",
  head_sha: "b907f33",
  event: "workflow_dispatch",
  conclusion: "success",
  name: "ci",
  html_url: "https://github.com/example/sample-repo/actions/runs/9",
  head_repository: { full_name: "example/sample-repo" },
};
const payload = (overrides: Record<string, unknown> = {}) => ({
  action: "completed",
  workflow_run: { ...run, ...overrides },
  repository: { full_name: "example/sample-repo", name: "sample-repo", owner: { login: "example" } },
});

describe("ciCheckFor", () => {
  it("mirrors a CI run thin-pr started on its branch as one check on that commit", () => {
    expect(ciCheckFor(payload())).toEqual({
      owner: "example",
      repo: "sample-repo",
      name: "thin-pr / ci",
      sha: "b907f33",
      conclusion: "success",
      title: "ci passed",
      summary: "[ci run](https://github.com/example/sample-repo/actions/runs/9) on `thin-pr/31` ended with success.",
    });
    expect(ciCheckFor(payload({ conclusion: "failure" }))).toMatchObject({ conclusion: "failure", title: "ci failed" });
    expect(ciCheckFor(payload({ conclusion: "cancelled" }))).toMatchObject({ conclusion: "failure", title: "ci failed" });
  });

  it("ignores runs a person started, other branches, forks and runs still going", () => {
    // A pull_request run shows on the draft already.
    expect(ciCheckFor(payload({ event: "pull_request" }))).toBeNull();
    expect(ciCheckFor(payload({ head_branch: "main" }))).toBeNull();
    expect(ciCheckFor(payload({ head_repository: { full_name: "someone/fork" } }))).toBeNull();
    expect(ciCheckFor({ ...payload(), action: "requested" })).toBeNull();
    expect(ciCheckFor({ action: "completed" })).toBeNull();
  });
});
