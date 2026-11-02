import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { runLabeledIssue } from "./labeled.js";
import { exportRunRecord } from "./record.js";
import { spanNames, startTrace } from "./trace.js";

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    core.setFailed("GITHUB_TOKEN is missing");
    return;
  }

  const tracing = startTrace();
  let failure = "";
  try {
    const runId = process.env.GITHUB_RUN_ID ? `gha-${process.env.GITHUB_RUN_ID}` : `local-${Date.now()}`;
    // actions/checkout leaves the default branch at the event's commit and stores no credentials; the push gets the token.
    const { result, spentUsd } = await runLabeledIssue({
      payload: github.context.payload,
      checkout: process.cwd(),
      baseSha: github.context.sha,
      token,
      runId,
      env: process.env,
    });
    if (spentUsd !== null) {
      core.info(`Model spend: ${spentUsd.toFixed(6)} USD`);
      const spendPath = process.env.THIN_PR_SPEND_PATH;
      if (spendPath) {
        writeFileSync(spendPath, `${JSON.stringify({ usd: spentUsd })}\n`);
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
    if (document === null) {
      core.info("Trace sent to the OTLP endpoint");
    } else {
      const tracePath = process.env.THIN_PR_TRACE_PATH;
      if (tracePath) {
        mkdirSync(dirname(tracePath), { recursive: true });
        writeFileSync(tracePath, document);
        core.info(`Trace file: ${tracePath}`);
      }
      core.info(`Trace spans: ${spanNames(JSON.parse(document) as unknown).join(", ")}`);
    }
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
