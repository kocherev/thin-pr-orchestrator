import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openEventLog, templateForLabel } from "@thin-pr/core";
import type { ModelSession } from "@thin-pr/specialists";
import { loadRepoConfig, openWorkspace, type GitWorkspace } from "@thin-pr/workspace";
import { readLabelEvent } from "./event.js";
import { exportRunRecord, type RunRecord } from "./record.js";
import { runIssue } from "./run.js";
import { createRunHandlers } from "./steps.js";
import type { GitHubSurface } from "./surface.js";

const exec = promisify(execFile);

const TEMPLATES = fileURLToPath(new URL("../../../templates", import.meta.url));

export type LocalRunResult = {
  readonly status: RunRecord["status"];
  readonly record: RunRecord;
  /** The branch that holds the change. Only a run that passes the gate, or waits for approval, creates one. */
  readonly branch: string | null;
  /** What GitHub would have received: the draft body when the gate passes, the run report comment otherwise. */
  readonly report: string;
  readonly recordPath: string;
};

/**
 * Runs `issue` against the committed HEAD of the checkout at `repo`, in a temporary worktree, with the
 * `thin-pr` template and no GitHub. A gate pass commits the change to a new local branch `thin-pr/local-<n>`.
 * Nothing is pushed. The RunRecord goes to `<runsDir>/<runId>.json`, by default under the repo's git directory,
 * so it never shows up as a change in the checkout.
 */
export async function runLocal(input: {
  readonly repo: string;
  /** The first line is the title, with any leading `#` dropped. The rest is the body. */
  readonly issue: string;
  readonly model: () => ModelSession;
  readonly runsDir?: string;
}): Promise<LocalRunResult> {
  const repo = resolve(input.repo);
  const [heading = "", ...rest] = input.issue.trim().split("\n");
  const title = heading.replace(/^#+\s*/, "").trim();
  if (title.length === 0) {
    throw new Error("issue text is empty");
  }
  const template = templateForLabel(TEMPLATES, "thin-pr");
  if (!template) {
    throw new Error("no template has the label thin-pr");
  }

  const baseSha = (await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const number = (await lastLocalNumber(repo)) + 1;
  const branch = `thin-pr/local-${number}`;
  const runId = `local-${Date.now()}`;
  const runsDir = input.runsDir ?? join(resolve(repo, (await git(repo, ["rev-parse", "--git-common-dir"])).trim()), "thin-pr", "runs");
  const payload = {
    action: "labeled",
    label: { name: "thin-pr" },
    issue: { number, title, body: rest.join("\n").trim() },
    repository: { name: basename(repo), default_branch: "HEAD", owner: { login: "local" } },
  };
  // A local issue has no page to link to.
  const labelEvent = readLabelEvent(payload);
  const event = { ...labelEvent, issue: { ...labelEvent.issue, url: "" } };

  const scratch = mkdtempSync(join(tmpdir(), "thin-pr-local-"));
  const dir = join(scratch, "checkout");
  await git(repo, ["worktree", "add", "--quiet", "--detach", dir, baseSha]);
  const log = openEventLog(join(scratch, "events.sqlite"));
  try {
    const config = loadRepoConfig(dir);
    const checkout = await openWorkspace({ dir, baseSha, config });
    const workspace: GitWorkspace = {
      ...checkout,
      // The worktree shares the repo's remotes, so a local run commits to a new branch and never pushes.
      async commitAndPush({ branch: name, message }) {
        await git(dir, ["add", "--all"]);
        await git(dir, ["commit", "--quiet", "--no-verify", "--message", message]);
        await git(dir, ["branch", name]);
        return (await git(dir, ["rev-parse", "HEAD"])).trim();
      },
    };
    const posted: string[] = [];
    const result = await runIssue({
      event,
      template,
      config,
      workspace,
      handlers: (limits) => createRunHandlers(input.model(), workspace, limits),
      github: localSurface(posted),
      log,
      runId,
      branch,
    });
    if (result.status === "ignored") {
      throw new Error("the local run ignored the issue");
    }
    // A local run opens no pull request.
    const record: RunRecord = { ...result.record, pullRequest: null };
    const recordPath = join(runsDir, `${runId}.json`);
    exportRunRecord(record, recordPath);
    return {
      status: record.status,
      record,
      branch: record.status === "opened" || record.status === "awaiting_approval" ? branch : null,
      report: posted.at(-1) ?? "",
      recordPath,
    };
  } finally {
    log.close();
    await git(repo, ["worktree", "remove", "--force", dir]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function lastLocalNumber(repo: string): Promise<number> {
  const refs = await git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/thin-pr/"]);
  const numbers = refs.split("\n").map((ref) => Number(/^refs\/heads\/thin-pr\/local-(\d+)$/.exec(ref)?.[1] ?? 0));
  return Math.max(0, ...numbers);
}

/** Keeps the comment or draft body a run posts. Checks have nowhere to go. */
function localSurface(posted: string[]): GitHubSurface {
  let nextCheck = 1;
  return {
    async startCheck() {
      nextCheck += 1;
      return nextCheck - 1;
    },
    async finishCheck() {},
    async comment({ body }) {
      posted.push(body);
    },
    async branchHead() {
      return null;
    },
    async listPullsForHead() {
      return [];
    },
    async updatePull({ number }) {
      return { number, url: "" };
    },
    async openDraft({ body }) {
      posted.push(body);
      return { number: 0, url: "" };
    },
  };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
    return stdout;
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    throw new Error(`git ${args[0] ?? ""} failed in ${cwd}${stderr ? `: ${stderr}` : ""}`, { cause: error });
  }
}
