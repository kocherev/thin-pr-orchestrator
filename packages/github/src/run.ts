import {
  openEventLog,
  runWorkflow,
  templateForLabel,
  type EventLog,
  type Json,
  type StepHandler,
  type StepId,
  type Template,
} from "@thin-pr/core";
import { decide, evaluate, type GateRuleResult } from "@thin-pr/gate";
import {
  implementerOutput,
  plannerOutput,
  prWriterOutput,
  reviewerOutput,
  verifyOutput,
  type CheckResult,
  type Diff,
  type ModelSession,
} from "@thin-pr/specialists";
import { loadRepoConfig, openWorkspace, type GitWorkspace, type RepoConfig } from "@thin-pr/workspace";
import { storedRunMarker, toStoredRun, type StoredRun } from "./approval.js";
import { createCheckRuns } from "./checks.js";
import { readLabelEvent, type LabelEvent } from "./event.js";
import { toRunRecord, type RunRecord, type TimedEvent } from "./record.js";
import { startProgress, type Progress } from "./progress.js";
import { formatRunReport } from "./report.js";
import { createRunHandlers } from "./steps.js";
import type { GitHubSurface } from "./surface.js";

export type LabelRunResult =
  | { readonly status: "ignored" }
  | { readonly status: "opened"; readonly record: RunRecord }
  /** `stored` is also in the issue comment, for `openApprovedDraft`. */
  | { readonly status: "awaiting_approval"; readonly record: RunRecord; readonly stored: StoredRun }
  | { readonly status: "blocked" | "failed"; readonly record: RunRecord; readonly error: string };

/** What one run may change and spend: the template's limits with the `.thin-pr.yml` overrides applied field by field. */
export type RunLimits = {
  readonly budget: { readonly max_files: number; readonly max_lines: number };
  readonly spendUsd: number;
};

export function runLimits(template: Template, config: RepoConfig): RunLimits {
  return {
    budget: {
      max_files: config.budget.max_files ?? template.budget.max_files,
      max_lines: config.budget.max_lines ?? template.budget.max_lines,
    },
    spendUsd: config.spend_usd ?? template.spend_usd,
  };
}

const CONTRACTS: Record<StepId, { safeParse(value: unknown): { success: boolean } }> = {
  plan: plannerOutput,
  implement: implementerOutput,
  verify: verifyOutput,
  review: reviewerOutput,
  write: prWriterOutput,
};

/**
 * Runs a labeled-issue payload against the checkout at `checkout`, whose HEAD is `baseSha`. `templates` is the
 * directory of workflow templates. Labels without a template are ignored.
 */
export async function runAction(input: {
  readonly payload: unknown;
  readonly templates: string;
  readonly checkout: string;
  readonly baseSha: string;
  readonly runId: string;
  readonly logPath: string;
  readonly github: GitHubSurface;
  /** Called inside the run, so a model that cannot start fails the run with an issue comment. */
  readonly model: () => ModelSession;
  /** Reaches only the push. The Action passes GITHUB_TOKEN because its checkout keeps no credentials. */
  readonly pushToken?: string;
  readonly runLink?: string | null;
}): Promise<LabelRunResult> {
  const event = readLabelEvent(input.payload);
  const template = templateForLabel(input.templates, event.label);
  if (event.action !== "labeled" || !template) {
    return { status: "ignored" };
  }
  const config = loadRepoConfig(input.checkout);
  const workspace = await openWorkspace({ dir: input.checkout, baseSha: input.baseSha, config });
  const log = openEventLog(input.logPath);
  try {
    return await runIssue({
      event,
      template,
      config,
      workspace,
      handlers: (limits) => createRunHandlers(input.model(), workspace, limits),
      github: input.github,
      log,
      runId: input.runId,
      pushToken: input.pushToken,
      runLink: input.runLink ?? null,
    });
  } finally {
    log.close();
  }
}

/**
 * Runs the template with a check per step, then evaluates the gate over the workspace. One issue comment shows the
 * progress and ends as the run report. A pass commits the change, force-pushes `thin-pr/<issue>` from the base, and
 * opens a draft or updates the open one. A diff over the budget that passes every other rule is pushed the same way,
 * but opens no draft: the report says how to approve it and stores the run for `openApprovedDraft`. Anything else
 * ends with the report and pushes nothing.
 */
export async function runIssue(deps: {
  readonly event: LabelEvent;
  readonly template: Template;
  readonly config: RepoConfig;
  readonly workspace: GitWorkspace;
  /**
   * Built first inside the run, so a setup error such as a missing API key is reported on the issue. The model steps
   * must keep to `limits.spendUsd`.
   */
  readonly handlers: (limits: RunLimits) => Readonly<Record<StepId, StepHandler>>;
  readonly github: GitHubSurface;
  readonly log: EventLog;
  readonly runId: string;
  readonly pushToken?: string;
  /** Defaults to `thin-pr/<issue>`. */
  readonly branch?: string;
  /** Markdown that links to where the run executes, for the progress comment. */
  readonly runLink?: string | null;
}): Promise<LabelRunResult> {
  const { event, workspace, github } = deps;
  const target = { owner: event.owner, repo: event.repo };
  const checkRuns = createCheckRuns(github, target);
  const branch = deps.branch ?? `thin-pr/${event.issue.number}`;
  const limits = runLimits(deps.template, deps.config);
  const timeline: TimedEvent[] = [];
  let diff: Diff | null = null;
  let checks: readonly CheckResult[] = [];
  let gate: readonly GateRuleResult[] = [];
  let outputs: Readonly<Partial<Record<StepId, Json>>> = {};

  const record = (status: RunRecord["status"], pullRequest: RunRecord["pullRequest"] = null): RunRecord =>
    toRunRecord({ runId: deps.runId, event, template: deps.template.id, status, timeline, gate, diff, checks, pullRequest });

  let progress: Progress | null = null;
  const finish = async (body: string): Promise<void> => {
    if (progress) {
      return progress.finish(body);
    }
    await github.createComment({ ...target, issue: event.issue.number, body });
  };

  const stop = async (status: "blocked" | "failed", error: string): Promise<LabelRunResult> => {
    const result = record(status);
    await finish(formatRunReport({ record: result, outputs, branch, error }));
    return { status, record: result, error };
  };

  try {
    const comment = await startProgress({
      github,
      ...target,
      issue: event.issue.number,
      title: `Running the ${deps.template.id} template on #${event.issue.number}.`,
      steps: deps.template.steps.map((step) => step.id),
      runId: deps.runId,
      runLink: deps.runLink ?? null,
    });
    progress = comment;
    const handlers = deps.handlers(limits);
    // Before the workflow, so the implementer's run_check already has the dependencies.
    const install = await workspace.install();
    if (install && install.exitCode !== 0) {
      return await stop("failed", `install failed (exit ${install.exitCode}): ${install.command}\n${install.logTail}`);
    }
    const state = await runWorkflow({
      runId: deps.runId,
      issue: event.issueText,
      template: deps.template,
      handlers,
      log: deps.log,
      async onEvent(runEvent) {
        timeline.push({ event: runEvent, at: new Date() });
        await checkRuns.onEvent(runEvent, workspace.baseSha);
        await comment.onEvent(runEvent);
      },
    });
    outputs = state.outputs;
    diff = await workspace.diff();
    checks = verifyOutput.safeParse(state.outputs.verify).data?.checks ?? [];
    if (state.status !== "completed") {
      return await stop("failed", timeline.at(-1)?.event.error ?? "run failed");
    }
    await comment.gating();

    const evidence = {
      plan: state.outputs.plan,
      review: state.outputs.review,
      contracts: deps.template.steps.map(({ id }) => ({ step: id, valid: CONTRACTS[id].safeParse(state.outputs[id]).success })),
      diff,
      checks,
      budget: limits.budget,
      config: deps.config,
    };
    gate = evaluate(evidence);
    const decision = decide(evidence);
    if (decision === "fail") {
      await checkRuns.postRules(gate, workspace.baseSha);
      const failed = gate.filter((result) => result.verdict === "FAIL").map((result) => result.rule);
      return await stop("blocked", `gate failed: ${failed.join(", ")}`);
    }

    const message = `Apply thin-pr/#${event.issue.number}`;
    const head = await workspace.commitAndPush({ branch, message, token: deps.pushToken });
    await checkRuns.postRules(gate, head);
    if (decision === "needs_approval") {
      const waiting = record("awaiting_approval");
      const stored = toStoredRun({
        record: waiting,
        branch: { name: branch, head, base: event.defaultBranch },
        title: draftTitle(event, outputs),
        plan: plannerOutput.safeParse(outputs.plan).data ?? null,
        review: reviewerOutput.safeParse(outputs.review).data ?? null,
      });
      const report = formatRunReport({ record: waiting, outputs, branch, error: null });
      await finish(`${report}\n\n${storedRunMarker(stored)}`);
      // A draft from an earlier run already shows the pushed branch, so its body must stop saying the gate passed.
      const [open] = await github.listPullsForHead({ ...target, branch });
      if (open) {
        await github.updatePull({ ...target, number: open.number, body: report });
      }
      return { status: "awaiting_approval", record: waiting, stored };
    }
    const body = formatRunReport({ record: record("opened"), outputs, branch, error: null });
    const pullRequest = await publishDraft(github, event, branch, outputs, body);
    const opened = record("opened", pullRequest);
    await finish(formatRunReport({ record: opened, outputs, branch, error: null }));
    return { status: "opened", record: opened };
  } catch (error) {
    let message = error instanceof Error && error.message.length > 0 ? error.message : "run failed";
    try {
      await checkRuns.abort(message);
    } catch (checkError) {
      message = `${message}; check update failed: ${checkError instanceof Error ? checkError.message : "unknown"}`;
    }
    return stop("failed", message);
  }
}

// A second label on the same issue reuses the branch, so an open draft for it gets the new body.
async function publishDraft(
  github: GitHubSurface,
  event: LabelEvent,
  branch: string,
  outputs: Readonly<Partial<Record<StepId, Json>>>,
  body: string,
): Promise<{ readonly number: number; readonly url: string }> {
  const target = { owner: event.owner, repo: event.repo };
  const [open] = await github.listPullsForHead({ ...target, branch });
  if (open) {
    return github.updatePull({ ...target, number: open.number, body });
  }
  return github.openDraft({ ...target, title: draftTitle(event, outputs), head: branch, base: event.defaultBranch, body, draft: true });
}

function draftTitle(event: LabelEvent, outputs: Readonly<Partial<Record<StepId, Json>>>): string {
  return prWriterOutput.safeParse(outputs.write).data?.title ?? `thin-pr #${event.issue.number}`;
}
