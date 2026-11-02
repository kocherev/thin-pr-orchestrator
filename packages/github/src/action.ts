import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { clientOptionsFromEnv, createAnthropicClient, type ModelSession } from "@thin-pr/specialists";
import { exportRunRecord } from "./record.js";
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
    const sessions: ModelSession[] = [];
    // A labeled issue asks for a real change, so the Action calls the model unless THIN_PR_MODEL says otherwise.
    const options = clientOptionsFromEnv({ ...process.env, THIN_PR_MODEL: process.env.THIN_PR_MODEL || "live" });
    const model = (): ModelSession => {
      if (options.mode !== "replay" && !process.env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY is missing. Add it as a repository secret so the thin-pr workflow can call the model.");
      }
      const session = createAnthropicClient(options);
      sessions.push(session);
      return session;
    };
    const runId = process.env.GITHUB_RUN_ID ? `gha-${process.env.GITHUB_RUN_ID}` : `local-${Date.now()}`;
    // actions/checkout leaves the default branch at the event's commit and stores no credentials; the push gets the token.
    const result = await runAction({
      payload: github.context.payload,
      templates: fileURLToPath(new URL("../../../templates", import.meta.url)),
      checkout: process.cwd(),
      baseSha: github.context.sha,
      pushToken: token,
      runId,
      logPath: join(tmpdir(), `thin-pr-${runId}.sqlite`),
      github: createGitHubSurface(new Octokit({ auth: token })),
      model,
    });
    const session = sessions[0];
    if (session && options.mode !== "replay") {
      const spend = { usd: session.meter.spentUsd };
      core.info(`Model spend: ${spend.usd.toFixed(6)} USD`);
      const spendPath = process.env.THIN_PR_SPEND_PATH;
      if (spendPath) {
        writeFileSync(spendPath, `${JSON.stringify(spend)}\n`);
      }
    }

    if (result.status !== "ignored") {
      exportRunRecord(result.record, process.env.THIN_PR_RECORD_PATH);
    }
    if (result.status === "blocked" || result.status === "failed") {
      failure = result.error;
    } else if (result.status === "opened") {
      core.info(`Draft pull request ${result.record.pullRequest?.url ?? "opened"}`);
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
