import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { ciCheckFor } from "./ci-check.js";
import { exportRunRecord } from "./record.js";
import { createGitHubSurface } from "./surface.js";
import { routeEvent, type Trigger } from "./router.js";
import { spanNames, startTrace } from "./trace.js";
import { pushedBranch, runResultOf, runTrigger } from "./trigger.js";

/** The account GitHub posts as for a workflow's `GITHUB_TOKEN`. */
const ACTIONS_BOT = "github-actions[bot]";

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
    if (github.context.eventName === "workflow_run") {
      await mirrorCi(token);
    } else if (route.kind === "run") {
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
  // actions/checkout stores no credentials; the push gets the token. For a label or a command it leaves the default
  // branch at the event's commit. For a review it checks out the draft branch, whose head may be newer than the
  // event, so the run starts from HEAD.
  const { outcome, spentUsd } = await runTrigger({
    trigger,
    checkout: process.cwd(),
    baseSha: trigger.kind === "revise" ? "HEAD" : github.context.sha,
    token,
    runId,
    runLink: actionsRunLink(process.env),
    botLogin: ACTIONS_BOT,
    env: process.env,
  });
  await startCi(trigger, pushedBranch(trigger, outcome), token);
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

  if (outcome.kind === "revise") {
    const { result } = outcome;
    if (result.status === "ignored") {
      core.info(`Nothing to revise: ${result.reason}.`);
      return "";
    }
    exportRunRecord(result.record, process.env.THIN_PR_RECORD_PATH);
    if (result.status === "pushed") {
      core.info(`Pushed ${result.head} to ${trigger.kind === "revise" ? trigger.pull.branch : "the draft"}.`);
      return "";
    }
    return failureOf(result);
  }
  const result = runResultOf(outcome);
  if (!result || result.status === "ignored") {
    return "";
  }
  exportRunRecord(result.record, process.env.THIN_PR_RECORD_PATH);
  switch (result.status) {
    case "blocked":
    case "failed":
      return failureOf(result);
    case "opened":
      core.info(`Draft pull request ${result.record.pullRequest?.url ?? "opened"}`);
      return "";
    case "awaiting_approval":
      core.info(`Pushed ${result.stored.branch.name}. The diff is over the budget and waits for approval on the issue.`);
      return "";
  }
}

/** Posts the result of a CI run thin-pr dispatched as `thin-pr / ci` on its commit, so the draft shows it. */
async function mirrorCi(token: string): Promise<void> {
  const check = ciCheckFor(github.context.payload);
  if (!check) {
    core.info("Nothing to do: this workflow run is not one thin-pr started.");
    return;
  }
  const surface = createGitHubSurface(new Octokit({ auth: token, baseUrl: process.env.GITHUB_API_URL }));
  await surface.postCheck(check);
  core.info(`Posted ${check.name}: ${check.title} on ${check.sha}.`);
}

/**
 * GitHub starts no workflow for a push made with the workflow's own token, except a workflow_dispatch. So with
 * THIN_PR_CI_WORKFLOW set, the Action starts that workflow on the branch it pushed, and its checks land on the draft.
 * A failure here is a warning: the change itself is fine.
 */
async function startCi(trigger: Trigger, branch: string | null, token: string): Promise<void> {
  const workflow = process.env.THIN_PR_CI_WORKFLOW;
  if (!workflow || !branch) {
    return;
  }
  try {
    await github.getOctokit(token).rest.actions.createWorkflowDispatch({
      owner: trigger.repo.owner,
      repo: trigger.repo.name,
      workflow_id: workflow,
      ref: branch,
    });
    core.info(`Started ${workflow} on ${branch}.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "dispatch failed";
    core.warning(`Could not start ${workflow} on ${branch}: ${reason}. It needs a workflow_dispatch trigger, and the job needs actions: write.`);
  }
}

/**
 * A blocked gate is a normal answer, already on the issue, so the job passes with a notice. Only a run that broke
 * fails the job: a red job there would say thin-pr broke when it only said no.
 */
function failureOf(result: { readonly status: "blocked" | "failed"; readonly error: string }): string {
  if (result.status === "blocked") {
    core.notice(`Blocked: ${result.error}. The issue comment has the report.`);
    return "";
  }
  return result.error;
}

function actionsRunLink(env: NodeJS.ProcessEnv): string | null {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId } = env;
  return server && repository && runId ? `[Actions run ${runId}](${server}/${repository}/actions/runs/${runId})` : null;
}

// The entry is packages/github/bin/action.js, which action.yml runs.
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "run failed";
  core.setFailed(message);
});
