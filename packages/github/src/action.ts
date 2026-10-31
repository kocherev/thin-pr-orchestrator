import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { createGitHubSurface } from "./surface.js";
import { runAction } from "./run.js";

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    core.setFailed("GITHUB_TOKEN is missing");
    return;
  }

  const runId = process.env.GITHUB_RUN_ID ? `gha-${process.env.GITHUB_RUN_ID}` : `local-${Date.now()}`;
  const result = await runAction({
    payload: github.context.payload,
    workspace: process.cwd(),
    runId,
    logPath: join(tmpdir(), `thin-pr-${runId}.sqlite`),
    github: createGitHubSurface(new Octokit({ auth: token })),
  });

  if (result.status === "failed") {
    core.setFailed(result.report.error);
    return;
  }
  if (result.status === "completed") {
    core.info(`Created ${result.branch} at ${result.headSha}`);
    core.info(`Draft pull request ${result.pullRequest.url}`);
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "run failed";
    core.setFailed(message);
  });
}
