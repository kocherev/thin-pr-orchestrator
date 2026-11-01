import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { AnthropicModelClient, createModelClient } from "@thin-pr/specialists";
import { runAction } from "./run.js";
import { createGitHubSurface } from "./surface.js";
import { spanNames, startTrace } from "./trace.js";

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    core.setFailed("GITHUB_TOKEN is missing");
    return;
  }

  const tracing = await startTrace();
  let failure = "";
  try {
    const model = createModelClient();
    const runId = process.env.GITHUB_RUN_ID ? `gha-${process.env.GITHUB_RUN_ID}` : `local-${Date.now()}`;
    const result = await runAction({
      payload: github.context.payload,
      workspace: process.cwd(),
      runId,
      logPath: join(tmpdir(), `thin-pr-${runId}.sqlite`),
      github: createGitHubSurface(new Octokit({ auth: token })),
      model,
    });
    if (model instanceof AnthropicModelClient) {
      const spend = { usd: model.spentUsd() };
      core.info(`Live model spend estimate: ${spend.usd.toFixed(6)} USD`);
      const spendPath = process.env.THIN_PR_SPEND_PATH;
      if (spendPath) {
        writeFileSync(spendPath, `${JSON.stringify(spend)}\n`);
      }
    }

    if (result.status === "failed") {
      failure = result.report.error;
    } else if (result.status === "completed") {
      core.info(`Created ${result.branch} at ${result.headSha}`);
      core.info(`Draft pull request ${result.pullRequest.url}`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : "run failed";
  }

  try {
    const document = await tracing.stop();
    const names = spanNames(JSON.parse(document) as unknown);
    const tracePath = process.env.THIN_PR_TRACE_PATH;
    if (tracePath) {
      mkdirSync(dirname(tracePath), { recursive: true });
      writeFileSync(tracePath, document);
      core.info(`Trace file: ${tracePath}`);
    }
    core.info(`Trace spans: ${names.join(", ")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "trace export failed";
    core.warning(message);
    if (failure.length === 0) {
      failure = message;
    }
  }
  if (failure.length > 0) {
    core.setFailed(failure);
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
