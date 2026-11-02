import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runLabeledIssue, startTrace, type RunRecord } from "@thin-pr/github";
import type { Job } from "../src/event.js";

const run = promisify(execFile);

/**
 * Clones the job's repository at the head of its default branch and runs the labeled issue there, as the Action
 * does. Returns the run record, or null when no template matches the label.
 */
export async function runJob(job: Job, env: NodeJS.ProcessEnv): Promise<RunRecord | null> {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is missing");
  }
  const parent = await mkdtemp(join(tmpdir(), `thin-pr-${job.deliveryId}-`));
  const checkout = join(parent, "checkout");
  // The container keeps no files, so a trace is worth starting only when a collector will receive it.
  const tracing = env.OTEL_EXPORTER_OTLP_ENDPOINT ? startTrace(env) : null;
  try {
    // Full history and every branch, like the Action's checkout, so a second label can push thin-pr/<issue> with a lease.
    const url = `https://github.com/${job.owner}/${job.repo}.git`;
    await run("git", ["clone", "--quiet", "--branch", job.defaultBranch, url, checkout], { env: withToken(env, token) });
    const { stdout } = await run("git", ["-C", checkout, "rev-parse", "HEAD"], { env });
    const { result } = await runLabeledIssue({
      payload: labeledPayload(job),
      checkout,
      baseSha: stdout.trim(),
      token,
      runId: `app-${job.deliveryId}`,
      env,
    });
    return result.status === "ignored" ? null : result.record;
  } finally {
    await rm(parent, { recursive: true, force: true });
    await flush(tracing);
  }
}

// A collector that is down must not turn a finished run into a failed one.
async function flush(tracing: { stop(): Promise<string | null> } | null): Promise<void> {
  try {
    await tracing?.stop();
  } catch (error) {
    console.error("trace export failed:", error instanceof Error ? error.message : error);
  }
}

// The webhook fields the Action's payload parser reads, rebuilt from the job.
function labeledPayload(job: Job) {
  return {
    action: "labeled",
    label: { name: job.label },
    issue: { number: job.issueNumber, title: job.issueTitle, body: job.issueBody },
    repository: { name: job.repo, default_branch: job.defaultBranch, owner: { login: job.owner } },
  };
}

// The token travels as a header from the environment, so it never lands in argv, error text, or .git/config.
function withToken(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}
