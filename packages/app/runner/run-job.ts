import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkoutBranch, runResultOf, runTrigger, startTrace, type RunRecord } from "@thin-pr/github";
import type { Job } from "../src/event.js";

const run = promisify(execFile);

/**
 * Clones the branch the trigger needs, the default branch or the draft a review is on, and runs the trigger there
 * as the Action does.
 * Returns what happened: the run record when the trigger started a run, otherwise the trigger kind and outcome.
 */
export async function runJob(
  job: Job,
  env: NodeJS.ProcessEnv,
): Promise<RunRecord | { readonly deliveryId: string; readonly trigger: string; readonly status: string }> {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is missing");
  }
  // The App comments as `<slug>[bot]`. Without the slug no stored run or reply could be trusted.
  const slug = env.GITHUB_APP_SLUG;
  if (!slug) {
    throw new Error("GITHUB_APP_SLUG is missing");
  }
  const parent = await mkdtemp(join(tmpdir(), `thin-pr-${job.deliveryId}-`));
  const checkout = join(parent, "checkout");
  // The container keeps no files, so a trace is worth starting only when a collector will receive it.
  const tracing = env.OTEL_EXPORTER_OTLP_ENDPOINT ? startTrace(env) : null;
  try {
    // Full history and every branch, like the Action's checkout, so a second label can push thin-pr/<issue> with a lease.
    const { repo } = job.trigger;
    const url = `https://github.com/${repo.owner}/${repo.name}.git`;
    const branch = checkoutBranch(job.trigger);
    await run("git", ["clone", "--quiet", "--branch", branch, url, checkout], { env: withToken(env, token) });
    const { stdout } = await run("git", ["-C", checkout, "rev-parse", "HEAD"], { env });
    const { outcome } = await runTrigger({
      trigger: job.trigger,
      checkout,
      baseSha: stdout.trim(),
      token,
      runId: `app-${job.deliveryId}`,
      runLink: `App delivery \`${job.deliveryId}\``,
      botLogin: `${slug}[bot]`,
      env,
    });
    const result = outcome.kind === "revise" ? outcome.result : runResultOf(outcome);
    if (result && "record" in result) {
      return result.record;
    }
    return { deliveryId: job.deliveryId, trigger: job.trigger.kind, status: result?.status ?? outcome.result.status };
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
