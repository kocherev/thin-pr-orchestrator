import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  openEventLog,
  runWorkflow,
  templateForLabel,
  type EventLog,
  type StepHandler,
  type StepId,
  type Template,
} from "@thin-pr/core";
import {
  decide,
  evaluate,
  measureDiff,
  parseBudget,
  type BudgetLimits,
  type DiffMeasurement,
  type FileChange,
  type GateRuleResult,
} from "@thin-pr/gate";
import { createStepHandlers, prWriterOutput, ReplayModelClient, type ModelClient } from "@thin-pr/specialists";
import { createCheckRuns } from "./checks.js";
import { readLabelEvent, type LabelEvent } from "./event.js";
import { toRunRecord, type RunRecord, type TimedEvent } from "./record.js";
import { formatDraftBody, formatRunReport } from "./report.js";
import { collectChanges, commitChanges, withSourceCheck } from "./runner.js";
import type { GitHubSurface } from "./surface.js";

export type LabelRunResult =
  | { readonly status: "ignored" }
  | { readonly status: "opened"; readonly record: RunRecord }
  | { readonly status: "blocked" | "failed"; readonly record: RunRecord; readonly error: string };

type LabelRunDeps = {
  readonly github: GitHubSurface;
  readonly template: Template;
  readonly handlers: Readonly<Record<StepId, StepHandler>>;
  readonly budget: BudgetLimits;
  readonly log: EventLog;
  readonly runId: string;
  /** Recorded file changes that replace the ones read from the implementer's edits. */
  readonly changes?: readonly FileChange[];
};

export async function runAction(input: {
  readonly payload: unknown;
  readonly workspace: string;
  readonly runId: string;
  readonly logPath: string;
  readonly github: GitHubSurface;
  readonly model?: ModelClient;
  readonly changes?: readonly FileChange[];
}): Promise<LabelRunResult> {
  const event = readLabelEvent(input.payload);
  const template = templateForLabel(join(input.workspace, "templates"), event.label);
  if (event.action !== "labeled" || !template) {
    return { status: "ignored" };
  }
  const log = openEventLog(input.logPath);
  try {
    return await runOnLabel(event, {
      github: input.github,
      template,
      handlers: createStepHandlers(input.model ?? new ReplayModelClient()),
      budget: parseBudget(JSON.parse(readFileSync(join(input.workspace, "evals", "budget.json"), "utf8"))),
      log,
      runId: input.runId,
      changes: input.changes,
    });
  } finally {
    log.close();
  }
}

/**
 * Creates `thin-pr/<issue>`, runs the template with a check per step, commits the measured change after
 * implement, then evaluates the gate. A pass opens a draft. Anything else comments the run report.
 */
async function runOnLabel(event: LabelEvent, deps: LabelRunDeps): Promise<LabelRunResult> {
  const target = { owner: event.owner, repo: event.repo };
  const checks = createCheckRuns(deps.github, target);
  const timeline: TimedEvent[] = [];
  let branch = "not created";
  let sha = "";
  let changes: readonly FileChange[] = [];
  let diff: DiffMeasurement | null = null;
  let gate: readonly GateRuleResult[] = [];

  const record = (status: RunRecord["status"], pullRequest: RunRecord["pullRequest"] = null): RunRecord =>
    toRunRecord({ runId: deps.runId, event, template: deps.template.id, status, timeline, gate, diff, pullRequest });

  const stop = async (status: "blocked" | "failed", error: string): Promise<LabelRunResult> => {
    const result = record(status);
    await deps.github.comment({ ...target, issue: event.issue.number, body: formatRunReport(result, branch, error) });
    return { status, record: result, error };
  };

  try {
    const baseSha = await deps.github.branchSha(event.owner, event.repo, event.defaultBranch);
    branch = `thin-pr/${event.issue.number}`;
    await deps.github.createBranch(event.owner, event.repo, branch, baseSha);
    sha = baseSha;

    const state = await runWorkflow({
      runId: deps.runId,
      issue: event.issueText,
      template: deps.template,
      handlers: { ...deps.handlers, verify: withSourceCheck(deps.handlers.verify, () => changes) },
      log: deps.log,
      async onEvent(runEvent) {
        timeline.push({ event: runEvent, at: new Date() });
        if (runEvent.step === "implement" && runEvent.kind === "finished") {
          changes = deps.changes ?? (await collectChanges(deps.github, target, baseSha, runEvent.output));
          diff = measureDiff(changes);
          const commit = { branch, parentSha: baseSha, message: `Apply thin-pr/#${event.issue.number}` };
          sha = (await commitChanges(deps.github, target, commit, changes, diff, deps.budget)) ?? sha;
        }
        await checks.onEvent(runEvent, sha);
      },
    });
    if (state.status !== "completed") {
      return await stop("failed", timeline.at(-1)?.event.error ?? "run failed");
    }

    const evidence = { outputs: state.outputs, diff, budget: deps.budget };
    gate = evaluate(evidence);
    await checks.postRules(gate, sha);
    if (decide(evidence) === "fail") {
      const failed = gate.filter((result) => result.verdict === "FAIL").map((result) => result.rule);
      return await stop("blocked", `gate failed: ${failed.join(", ")}`);
    }

    const pullRequest = await deps.github.openDraft({
      ...target,
      title: prWriterOutput.safeParse(state.outputs.write).data?.title ?? `thin-pr #${event.issue.number}`,
      head: branch,
      base: event.defaultBranch,
      body: formatDraftBody(state.outputs, formatRunReport(record("opened"), branch, null)),
      draft: true,
    });
    return { status: "opened", record: record("opened", pullRequest) };
  } catch (error) {
    let message = error instanceof Error && error.message.length > 0 ? error.message : "run failed";
    try {
      await checks.abort(message);
    } catch (checkError) {
      message = `${message}; check update failed: ${checkError instanceof Error ? checkError.message : "unknown"}`;
    }
    return stop("failed", message);
  }
}
