import { openApprovedDraft, readStoredRun, storedOutputs, type StoredRun } from "./approval.js";
import { labelEvent, type LabelEvent } from "./event.js";
import { isRunComment } from "./progress.js";
import { formatRunReport } from "./report.js";
import { TRIGGER_LABEL, type CommandTrigger } from "./router.js";
import type { LabelRunResult } from "./run.js";
import type { GitHubSurface } from "./surface.js";

export const HELP = [
  "thin-pr reads these commands from users with write access:",
  "",
  "- `/thin-pr approve` opens the draft for a run that waits for approval.",
  "- `/thin-pr retry` starts a fresh run with the issue's thin-pr label.",
  "- `/thin-pr cancel` stops a run that waits for approval and deletes its branch.",
].join("\n");

export type CommandResult =
  | { readonly status: "approved" | "cancelled" | "helped"; readonly detail: string }
  | { readonly status: "retried"; readonly run: LabelRunResult }
  | { readonly status: "refused"; readonly reason: string };

type Target = { readonly owner: string; readonly repo: string };

/**
 * Carries out one command from a user with write access, which the router has checked. It reacts with eyes first,
 * then +1 when the command ran or confused when it was refused. A refusal and the help text are short replies; a
 * retry answers with the new run's progress comment.
 */
export async function runCommand(
  trigger: CommandTrigger,
  deps: {
    readonly github: GitHubSurface;
    /** Starts a fresh run of the template `event.label` names. */
    readonly retry: (event: LabelEvent) => Promise<LabelRunResult>;
  },
): Promise<CommandResult> {
  const { github } = deps;
  const target = { owner: trigger.repo.owner, repo: trigger.repo.name };
  const self = await github.react({ ...target, on: { comment: trigger.comment.id }, content: "eyes" });
  const result = await execute(trigger, { ...deps, target, self });
  const reply = result.status === "refused" ? result.reason : result.status === "helped" ? HELP : null;
  if (reply) {
    await github.createComment({ ...target, issue: trigger.issue.number, body: reply });
  }
  if (result.status !== "helped") {
    await github.react({ ...target, on: { comment: trigger.comment.id }, content: result.status === "refused" ? "confused" : "+1" });
  }
  return result;
}

async function execute(
  trigger: CommandTrigger,
  deps: {
    readonly github: GitHubSurface;
    readonly retry: (event: LabelEvent) => Promise<LabelRunResult>;
    readonly target: Target;
    /** The token's own login. Only its comments can hold a stored run. */
    readonly self: string;
  },
): Promise<CommandResult> {
  const { github, target } = deps;
  if (trigger.command === "help") {
    return { status: "helped", detail: "help" };
  }
  const issueNumber = trigger.issue.pull ? await issueOfPull(github, target, trigger.issue.number) : trigger.issue.number;
  if (issueNumber === null) {
    return { status: "refused", reason: "This pull request is not a thin-pr draft, so there is no run to act on." };
  }
  const by = trigger.comment.author;

  if (trigger.command === "retry") {
    const issue = issueNumber === trigger.issue.number ? trigger.issue : await github.getIssue({ ...target, issue: issueNumber });
    const label = issue.labels.find((name) => TRIGGER_LABEL.test(name));
    if (!label) {
      return { status: "refused", reason: `#${issueNumber} has no thin-pr label, so there is no template to run. Add one to start a run.` };
    }
    const run = await deps.retry(labelEvent({ repo: trigger.repo, issue: { ...issue, number: issueNumber }, label }));
    if (run.status === "ignored") {
      return { status: "refused", reason: `No template has the label \`${label}\`.` };
    }
    return { status: "retried", run };
  }

  const waiting = await latestRun(github, target, issueNumber, deps.self);
  if (!waiting?.stored) {
    return { status: "refused", reason: `No run on #${issueNumber} waits for approval.` };
  }
  const { commentId, stored } = waiting;
  const edit = (body: string) => github.editComment({ ...target, commentId, body });

  if (trigger.command === "approve") {
    const approval = await openApprovedDraft(stored, { github, approvedBy: by });
    if (approval.status === "refused") {
      return { status: "refused", reason: approval.reason };
    }
    // The stored run leaves the comment with its marker, so a second approve finds nothing to approve.
    await edit(formatRunReport({ record: approval.record, outputs: storedOutputs(stored), branch: stored.branch.name, error: null, by }));
    return { status: "approved", detail: approval.record.pullRequest?.url ?? stored.branch.name };
  }

  const head = await github.branchHead({ ...target, branch: stored.branch.name });
  if (head !== null && head !== stored.branch.head) {
    return {
      status: "refused",
      reason: `\`${stored.branch.name}\` moved after the run, so it was not deleted. Delete it yourself if nobody needs the new commits.`,
    };
  }
  if (head !== null) {
    await github.deleteBranch({ ...target, branch: stored.branch.name });
  }
  await edit(cancelledReport(stored, by));
  return { status: "cancelled", detail: stored.branch.name };
}

/**
 * The newest run comment on the issue that the token itself wrote, and the run it stores. Comments by anyone else
 * are skipped even when they carry the markers, since anyone can type them.
 */
async function latestRun(
  github: GitHubSurface,
  target: Target,
  issue: number,
  self: string,
): Promise<{ readonly commentId: number; readonly stored: StoredRun | null } | null> {
  const ours = (await github.listComments({ ...target, issue })).filter((comment) => comment.author === self && isRunComment(comment.body));
  const last = ours.at(-1);
  return last ? { commentId: last.id, stored: readStoredRun(last.body) } : null;
}

async function issueOfPull(github: GitHubSurface, target: Target, number: number): Promise<number | null> {
  const pull = await github.getPull({ ...target, number });
  const match = /^thin-pr\/(\d+)$/.exec(pull.branch);
  return pull.sameRepo && match ? Number(match[1]) : null;
}

function cancelledReport(stored: StoredRun, by: string): string {
  return formatRunReport({
    record: { ...stored.record, status: "cancelled" },
    outputs: storedOutputs(stored),
    branch: stored.branch.name,
    error: null,
    by,
  });
}
