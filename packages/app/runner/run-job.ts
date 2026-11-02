import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Job } from "../src/event.js";

const run = promisify(execFile);

export async function runJob(job: Job, env: NodeJS.ProcessEnv): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `thin-pr-${job.deliveryId}-`));
  const url = `https://github.com/${job.owner}/${job.repo}.git`;
  await run("git", ["clone", "--depth", "1", url, directory], { env: gitEnv(env) });
  console.log(`${job.owner}/${job.repo}#${job.issueNumber} (${job.label}) is checked out at ${directory} and ready`);
}

// The token travels as a header from the environment, so it never lands in argv, error text, or .git/config.
function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const token = env.GITHUB_TOKEN;
  if (token === undefined || token.length === 0) {
    return { ...env, GIT_TERMINAL_PROMPT: "0" };
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}
