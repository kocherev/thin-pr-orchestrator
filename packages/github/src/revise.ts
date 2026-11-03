import { openEventLog, templateForLabel, type StepHandler, type StepId } from "@thin-pr/core";
import { implementerOutput, type Diff, type ModelSession } from "@thin-pr/specialists";
import { loadRepoConfig, openWorkspace } from "@thin-pr/workspace";
import { labelEvent } from "./event.js";
import type { RunRecord } from "./record.js";
import { cell, formatRunReport, reportDetails } from "./report.js";
import { REVISE_LABEL, type ReviseTrigger } from "./router.js";
import { gatedRun } from "./run.js";
import { createRunHandlers } from "./steps.js";
import { writtenBy, type GitHubSurface, type Review } from "./surface.js";

export type ReviseResult =
  | { readonly status: "ignored"; readonly reason: string }
  | { readonly status: "pushed"; readonly record: RunRecord; readonly head: string }
  | { readonly status: "blocked" | "failed"; readonly record: RunRecord; readonly error: string };

/** Marks the reply that answers one review, so the events for its inline comments do not answer it again. */
export function reviseMarker(reviewId: number): string {
  return `<!-- thin-pr-revise:${reviewId} -->`;
}

/**
 * Answers a review on a thin-pr draft. The checkout is the draft branch at its head. The review text and its
 * inline comments become the plan and the implement feedback, then the revise template runs verify, review, write
 * and the gate over the new commit only. A pass pushes one commit to the branch. One reply comment on the pull
 * request shows the progress and ends by saying what changed for each review comment, or why nothing was pushed.
 */
export async function runRevise(input: {
  readonly trigger: ReviseTrigger;
  readonly templates: string;
  readonly checkout: string;
  readonly baseSha: string;
  readonly runId: string;
  readonly logPath: string;
  readonly github: GitHubSurface;
  readonly model: () => ModelSession;
  readonly pushToken?: string;
  readonly runLink?: string | null;
  /** The app's own login. Only its reply marks a review as answered. */
  readonly botLogin: string;
}): Promise<ReviseResult> {
  const { trigger, github } = input;
  const target = { owner: trigger.repo.owner, repo: trigger.repo.name };
  const { number: pull, branch } = trigger.pull;
  const marker = reviseMarker(trigger.reviewId);

  const comments = await github.listComments({ ...target, issue: pull });
  if (comments.some((comment) => writtenBy(comment, input.botLogin) && comment.body.includes(marker))) {
    return { status: "ignored", reason: `review ${trigger.reviewId} already has a reply` };
  }
  const review = await github.getReview({ ...target, pull, reviewId: trigger.reviewId });
  if (review.body.trim().length === 0 && review.comments.length === 0) {
    return { status: "ignored", reason: `review ${trigger.reviewId} has no text to act on` };
  }
  const template = templateForLabel(input.templates, REVISE_LABEL);
  if (!template) {
    throw new Error(`no template has the label ${REVISE_LABEL}`);
  }
  const issue = await github.getIssue({ ...target, issue: trigger.pull.issue });
  const event = labelEvent({ repo: trigger.repo, issue, label: REVISE_LABEL });
  const config = loadRepoConfig(input.checkout);
  const workspace = await openWorkspace({ dir: input.checkout, baseSha: input.baseSha, config });
  const log = openEventLog(input.logPath);
  const by = `the review by ${trigger.reviewer}`;
  try {
    return await gatedRun<ReviseResult>({
      event,
      template,
      config,
      workspace,
      github,
      log,
      runId: input.runId,
      runLink: input.runLink ?? null,
      handlers: (limits) => withReview(createRunHandlers(input.model(), workspace, limits), review, trigger.reviewer),
      comment: { issue: pull, title: `Revising \`${branch}\` for ${by}.`, marker },
      async stop(status, record, outputs, error) {
        const body = `**Not revised.** Nothing was pushed to \`${branch}\` for ${by}.\n\n${formatRunReport({ record, outputs, branch, error })}`;
        return { body, result: { status, record, error } };
      },
      async gated({ decision, outputs, record, postRules, finish }) {
        const diff = await workspace.diff();
        if (decision === "needs_approval") {
          const blocked = record("blocked");
          const reason = blocked.gate.find((rule) => rule.verdict === "NEEDS_APPROVAL")?.reason ?? "The change is over the budget.";
          await finish(
            [
              `**Not revised.** ${reason} A revision is one commit a reviewer reads at once, so nothing was pushed to \`${branch}\`. Ask for less in one review, or label the issue again for a fresh run.`,
              perComment(review, diff),
              reportDetails({ record: blocked, outputs, branch }),
            ].join("\n\n"),
          );
          return { status: "blocked", record: blocked, error: `over the budget: ${reason}` };
        }
        const message = `Revise thin-pr/#${trigger.pull.issue} for review ${trigger.reviewId}`;
        const head = await workspace.commitAndPush({ branch, message, token: input.pushToken });
        await postRules(head);
        const pushed = record("opened", { number: pull, url: `https://github.com/${target.owner}/${target.repo}/pull/${pull}` });
        const change = implementerOutput.safeParse(outputs.implement).data?.summary;
        await finish(
          [
            `**Revised.** Pushed ${head.slice(0, 7)} to \`${branch}\` for ${by}. All ${pushed.gate.length} gate rules passed.${change ? ` ${change}` : ""}`,
            perComment(review, diff),
            reportDetails({ record: pushed, outputs, branch }),
          ].join("\n\n"),
        );
        return { status: "pushed", record: pushed, head };
      },
    });
  } finally {
    log.close();
  }
}

/**
 * The run's handlers with the review in place of the planner: the plan has one step per review comment, and
 * implement gets the full review on every pass, ahead of any loop feedback.
 */
export function withReview(
  handlers: Readonly<Record<StepId, StepHandler>>,
  review: Review,
  reviewer: string,
): Record<StepId, StepHandler> {
  const steps = [
    ...(review.body.trim() ? [`Address the review summary: ${cell(review.body)}`] : []),
    ...review.comments.map((comment) => `Address the comment on ${where(comment)}: ${cell(comment.body)}`),
  ];
  const plan = { summary: `Revise the draft for the review by ${reviewer}.`, steps };
  const feedback = [
    `Review by ${reviewer} on the draft. Change the branch so it answers every comment.`,
    ...(review.body.trim() ? [`Summary:\n${review.body.trim()}`] : []),
    ...review.comments.map((comment) => `${where(comment)}:\n${comment.body.trim()}`),
  ].join("\n\n");
  return {
    ...handlers,
    plan: async () => ({ outcome: "done", output: plan }),
    implement: (context) =>
      handlers.implement({ ...context, feedback: context.feedback ? `${feedback}\n\n${context.feedback}` : feedback }),
  };
}

// What the new commit did for each inline comment. The model does not report this, so it is read from the diff.
function perComment(review: Review, diff: Diff): string {
  if (review.comments.length === 0) {
    return "The review has no inline comments.";
  }
  const rows = review.comments.map((comment) => {
    const file = diff.files.find((candidate) => candidate.path === comment.path);
    const change = file ? `changed, +${file.added} -${file.removed}` : "not changed in this commit";
    return `| \`${cell(where(comment))}\` | ${cell(comment.body)} | ${change} |`;
  });
  return ["| Comment on | Asked | This commit |", "| --- | --- | --- |", ...rows].join("\n");
}

function where(comment: Review["comments"][number]): string {
  return comment.line === null ? comment.path : `${comment.path}:${comment.line}`;
}
