import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { exportRunRecord } from "./record.js";
import { routeEvent, type Trigger } from "./router.js";
import { spanNames, startTrace } from "./trace.js";
import { runResultOf, runTrigger } from "./trigger.js";

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    core.setFailed("GITHUB_TOKEN is missing");
    return;
  }

  const tracing = startTrace();
  let failure = "";
  try {
    const route = routeEvent(github.context.eventName, github.context.payload);
    // The workflow's condition filters most events. One that gets past it and starts nothing is no failure.
    if (route.kind === "run") {
      failure = await handle(route.trigger, token);
    } else if (route.kind === "invalid") {
      failure = `event payload invalid: ${route.reason}`;
    } else {
      core.info(`Nothing to do: ${route.reason}.`);
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

/** Runs the trigger and logs what happened. Returns the failure message, or "" when the job should pass. */
async function handle(trigger: Trigger, token: string): Promise<string> {
  const runId = process.env.GITHUB_RUN_ID ? `gha-${process.env.GITHUB_RUN_ID}` : `local-${Date.now()}`;
  // actions/checkout leaves the default branch at the event's commit and stores no credentials; the push gets the token.
  const { outcome, spentUsd } = await runTrigger({
    trigger,
    checkout: process.cwd(),
    baseSha: github.context.sha,
    token,
    runId,
    runLink: actionsRunLink(process.env),
    env: process.env,
  });
  if (outcome.kind === "command") {
    const { result } = outcome;
    core.info(`Command: ${result.status}${result.status === "refused" ? `. ${result.reason}` : ""}`);
  }
  if (spentUsd !== null) {
    core.info(`Model spend: ${spentUsd.toFixed(6)} USD`);
    const spendPath = process.env.THIN_PR_SPEND_PATH;
    if (spendPath) {
      writeFileSync(spendPath, `${JSON.stringify({ usd: spentUsd })}\n`);
    }
  }

  const result = runResultOf(outcome);
  if (!result || result.status === "ignored") {
    return "";
  }
  exportRunRecord(result.record, process.env.THIN_PR_RECORD_PATH);
  switch (result.status) {
    case "blocked":
    case "failed":
      return result.error;
    case "opened":
      core.info(`Draft pull request ${result.record.pullRequest?.url ?? "opened"}`);
      return "";
    case "awaiting_approval":
      core.info(`Pushed ${result.stored.branch.name}. The diff is over the budget and waits for approval on the issue.`);
      return "";
  }
}

function actionsRunLink(env: NodeJS.ProcessEnv): string | null {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId } = env;
  return server && repository && runId ? `[Actions run ${runId}](${server}/${repository}/actions/runs/${runId})` : null;
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
