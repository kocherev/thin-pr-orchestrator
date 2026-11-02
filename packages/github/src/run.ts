import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  openEventLog,
  runWorkflow,
  templateForLabel,
  type EventLog,
  type Json,
  type RunEvent,
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
  type FileChange,
  type GateRuleResult,
} from "@thin-pr/gate";
import {
  createStepHandlers,
  ReplayModelClient,
  implementerOutput,
  plannerOutput,
  prWriterOutput,
  summaryOf,
  verifyOutput,
  type ModelClient,
} from "@thin-pr/specialists";
import { withSourceCheck } from "./runner.js";
import type { GitHubSurface } from "./surface.js";

export type StepReport = {
  readonly step: string;
  readonly conclusion: "success" | "failure";
  readonly summary: string;
};

export type RunReport = {
  readonly runId: string;
  readonly templateId: string;
  readonly issueNumber: number;
  readonly branch: string;
  readonly error: string;
  readonly steps: readonly StepReport[];
};

export type LabelEvent = {
  readonly action: string;
  readonly label: string;
  readonly issueNumber: number;
  readonly issueText: string;
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string;
};

export type LabelRunResult =
  | { readonly status: "ignored" }
  | {
      readonly status: "completed";
      readonly branch: string;
      readonly headSha: string;
      readonly checks: readonly StepReport[];
      readonly pullRequest: { readonly number: number; readonly url: string };
    }
  | {
      readonly status: "failed";
      readonly branch: string;
      readonly headSha: string | null;
      readonly report: RunReport;
    };

export type LabelRunDeps = {
  readonly github: GitHubSurface;
  readonly template: Template;
  readonly handlers: Readonly<Record<StepId, StepHandler>>;
  readonly changes?: readonly FileChange[];
  readonly budget: BudgetLimits;
  readonly log: EventLog;
  readonly runId: string;
};

export function branchName(issueNumber: number): string {
  return `thin-pr/${issueNumber}`;
}

export function checkName(step: string): string {
  return `thin-pr / ${step}`;
}

export function formatRunReport(report: RunReport): string {
  const lines = [
    "## Run report",
    "",
    `- Run: ${report.runId}`,
    `- Template: ${report.templateId}`,
    `- Issue: ${report.issueNumber}`,
    `- Branch: ${report.branch}`,
  ];
  if (report.error.length > 0) {
    lines.push(`- Error: ${report.error}`);
  }
  lines.push("", "### Steps");
  if (report.steps.length === 0) {
    lines.push("", "No step finished.");
  } else {
    for (const step of report.steps) {
      lines.push(`- ${step.step}: ${step.conclusion}. ${step.summary}`);
    }
  }
  return lines.join("\n");
}

export function readLabelEvent(payload: unknown): LabelEvent {
  const event = record(payload, "event payload");
  const label = record(event.label, "label");
  const issue = record(event.issue, "issue");
  const repository = record(event.repository, "repository");
  const owner = record(repository.owner, "repository.owner");
  const issueNumber = positiveInteger(issue.number, "issue.number");
  const title = text(issue.title, "issue.title");
  const body = issueBody(issue.body);
  const issueText = body.length === 0 ? `#${issueNumber} ${title}` : `#${issueNumber} ${title}\n\n${body}`;
  return {
    action: text(event.action, "action"),
    label: text(label.name, "label.name"),
    issueNumber,
    issueText,
    owner: text(owner.login, "repository.owner.login"),
    repo: text(repository.name, "repository.name"),
    defaultBranch: text(repository.default_branch, "repository.default_branch"),
  };
}

export async function runOnLabel(event: LabelEvent, deps: LabelRunDeps): Promise<LabelRunResult> {
  const steps: StepReport[] = [];
  let open: { readonly step: string; readonly id: number } | null = null;
  let branch = "not created";
  let headSha: string | null = null;
  let sha = "";
  let changes: readonly FileChange[] = [];
  let failure = "run failed";

  const startCheck = async (step: string): Promise<void> => {
    if (!open) {
      open = { step, id: await deps.github.startCheck({ owner: event.owner, repo: event.repo, name: checkName(step), sha }) };
    }
  };
  const finishCheck = async (conclusion: "success" | "failure", summary: string): Promise<void> => {
    const current: { readonly step: string; readonly id: number } | null = open;
    if (!current) {
      return;
    }
    open = null;
    await deps.github.finishCheck({ owner: event.owner, repo: event.repo, checkRunId: current.id, conclusion, summary });
    steps.push({ step: current.step, conclusion, summary });
  };

  try {
    const baseSha = await deps.github.branchSha(event.owner, event.repo, event.defaultBranch);
    branch = branchName(event.issueNumber);
    await deps.github.createBranch(event.owner, event.repo, branch, baseSha);
    headSha = baseSha;
    sha = baseSha;

    const state = await runWorkflow({
      runId: deps.runId,
      issue: event.issueText,
      template: deps.template,
      handlers: { ...deps.handlers, verify: withSourceCheck(deps.handlers.verify, () => changes) },
      log: deps.log,
      async onEvent(runEvent: RunEvent) {
        if (runEvent.step === "implement" && runEvent.kind === "finished") {
          changes = await collectChanges(deps, event, baseSha, runEvent.output);
          const committed = await commitChanges(deps, event, baseSha, branch, changes);
          if (committed) {
            sha = committed;
            headSha = committed;
          }
        }
        if (runEvent.step === null) {
          if (runEvent.kind === "failed") {
            failure = runEvent.error ?? failure;
            await finishCheck("failure", failure);
          }
          return;
        }
        if (runEvent.kind === "started") {
          await startCheck(runEvent.step);
        } else if (runEvent.kind === "finished") {
          await finishCheck("success", summaryOf(runEvent.output));
        } else if (runEvent.kind === "looped") {
          await finishCheck("failure", runEvent.feedback ?? "");
        }
      },
    });
    if (state.status !== "completed") {
      throw new Error(failure);
    }

    const evidence = { outputs: state.outputs, diff: measureDiff(changes), budget: deps.budget };
    for (const result of evaluate(evidence)) {
      await postRule(deps, event, sha, result, steps);
    }
    if (decide(evidence) === "fail") {
      throw new Error("gate decide returned fail");
    }

    const pullRequest = await deps.github.openDraft({
      owner: event.owner,
      repo: event.repo,
      title: prWriterOutput.safeParse(state.outputs.write).data?.title ?? `thin-pr #${event.issueNumber}`,
      head: branch,
      base: event.defaultBranch,
      body: formatDraftBody(
        state.outputs,
        formatRunReport({
          runId: deps.runId,
          templateId: deps.template.id,
          issueNumber: event.issueNumber,
          branch,
          error: "",
          steps,
        }),
      ),
      draft: true,
    });
    return { status: "completed", branch, headSha: sha, checks: [...steps], pullRequest };
  } catch (error) {
    let message = errorText(error);
    try {
      await finishCheck("failure", message);
    } catch (checkError) {
      message = `${message}; check update failed: ${errorText(checkError)}`;
    }

    const report: RunReport = {
      runId: deps.runId,
      templateId: deps.template.id,
      issueNumber: event.issueNumber,
      branch,
      error: message,
      steps: [...steps],
    };
    await deps.github.comment({
      owner: event.owner,
      repo: event.repo,
      issue: event.issueNumber,
      body: formatRunReport(report),
    });
    return { status: "failed", branch, headSha, report };
  }
}

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
      changes: input.changes,
      budget: parseBudget(JSON.parse(readFileSync(join(input.workspace, "evals", "budget.json"), "utf8"))),
      log,
      runId: input.runId,
    });
  } finally {
    log.close();
  }
}

async function collectChanges(
  deps: LabelRunDeps,
  event: LabelEvent,
  baseSha: string,
  output: Json | null,
): Promise<readonly FileChange[]> {
  if (deps.changes) {
    return deps.changes;
  }
  const edits = implementerOutput.safeParse(output).data?.edits ?? [];
  const changes: FileChange[] = [];
  for (const edit of edits) {
    if (!safeRelative(edit.path)) {
      throw new Error(`edit path escapes the tree: ${edit.path}`);
    }
    const before = await deps.github.readText({
      owner: event.owner,
      repo: event.repo,
      ref: baseSha,
      path: edit.path,
    });
    changes.push({ path: edit.path, before: before ?? "", after: edit.content });
  }
  return changes;
}

async function commitChanges(
  deps: LabelRunDeps,
  event: LabelEvent,
  baseSha: string,
  branch: string,
  changes: readonly FileChange[],
): Promise<string | null> {
  const diff = measureDiff(changes);
  const withinBudget = diff.files <= deps.budget.maxFiles && diff.lines <= deps.budget.maxLines;
  if (!diff.meaningful || !withinBudget) {
    return null;
  }
  return deps.github.commitFiles({
    owner: event.owner,
    repo: event.repo,
    branch,
    parentSha: baseSha,
    message: `Apply thin-pr/#${event.issueNumber}`,
    files: changes
      .filter((change) => change.before !== change.after)
      .map((change) => ({ path: change.path, content: change.after })),
  });
}

function safeRelative(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
}

async function postRule(
  deps: LabelRunDeps,
  event: LabelEvent,
  sha: string,
  result: GateRuleResult,
  steps: StepReport[],
): Promise<void> {
  const summary = `${result.verdict}: ${result.reason}`;
  const conclusion = result.verdict === "PASS" ? "success" : "failure";
  const id = await deps.github.startCheck({
    owner: event.owner,
    repo: event.repo,
    name: checkName(`gate / ${result.rule}`),
    sha,
  });
  await deps.github.finishCheck({
    owner: event.owner,
    repo: event.repo,
    checkRunId: id,
    conclusion,
    summary,
    title: result.verdict,
  });
  steps.push({ step: `gate/${result.rule}`, conclusion, summary });
}

function formatDraftBody(outputs: Readonly<Partial<Record<StepId, Json>>>, report: string): string {
  return ["## Plan", "", formatPlan(outputs.plan), "", "## Test results", "", formatTests(outputs.verify), "", report].join(
    "\n",
  );
}

function formatPlan(output: Json | undefined): string {
  const plan = plannerOutput.safeParse(output);
  if (!plan.success) {
    return "Plan is missing.";
  }
  const steps = plan.data.steps.map((step) => `- ${step}`).join("\n");
  return `${plan.data.summary}\n\n${steps}`;
}

function formatTests(output: Json | undefined): string {
  const test = verifyOutput.safeParse(output);
  if (!test.success) {
    return "Test result is missing.";
  }
  const result = test.data.passed ? "Tests passed." : "Tests did not pass.";
  return `${test.data.summary}\n\n${result}`;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "run failed";
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function issueBody(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error("issue.body must be text");
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}
