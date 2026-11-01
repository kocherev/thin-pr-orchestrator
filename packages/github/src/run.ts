import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isStepName,
  loadTemplate,
  openEventLog,
  runWorkflow,
  type EventLog,
  type GateHook,
  type SpecialistMap,
  type WorkflowTemplate,
} from "@thin-pr/core";
import {
  decide,
  evaluate,
  measureDiff,
  parseBudget,
  type FileChange,
  type GateRuleResult,
  type RunnerEvidence,
} from "@thin-pr/gate";
import {
  createRunCapture,
  createStubSpecialists,
  type CapturedRun,
  type ModelClient,
} from "@thin-pr/specialists";
import { confirmSources } from "./runner.js";
import type { GitHubSurface } from "./surface.js";

export const TRIGGER_LABEL = "thin-pr" as const;

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
  readonly template: WorkflowTemplate;
  readonly specialists: SpecialistMap;
  readonly gates?: Readonly<Record<string, GateHook>>;
  readonly capture?: CapturedRun;
  readonly changes?: readonly FileChange[];
  readonly budget: RunnerEvidence["budget"];
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
  if (event.action !== "labeled" || event.label !== TRIGGER_LABEL) {
    return { status: "ignored" };
  }

  const steps: StepReport[] = [];
  let current: { readonly step: string; readonly id: number } | null = null;
  let branch = "not created";
  let headSha: string | null = null;
  const capture = deps.capture ?? createRunCapture();
  let evidence: RunnerEvidence = {
    diff: { files: 0, lines: 0, meaningful: false },
    testsPassed: false,
    budget: deps.budget,
  };
  let sha = "";

  try {
    const baseSha = await deps.github.branchSha(event.owner, event.repo, event.defaultBranch);
    branch = branchName(event.issueNumber);
    await deps.github.createBranch(event.owner, event.repo, branch, baseSha);
    headSha = baseSha;
    sha = baseSha;

    await runWorkflow({
      runId: deps.runId,
      issue: event.issueText,
      template: deps.template,
      specialists: deps.specialists,
      gates: deps.gates ?? { decide: () => applyRules(deps, event, sha, capture, steps, evidence) },
      log: deps.log,
      async onTransition(transition) {
        if (transition.output?.step === "implement") {
          const applied = await applyImplementDiff(deps, event, baseSha, branch, capture);
          evidence = applied.evidence;
          if (applied.sha) {
            sha = applied.sha;
            headSha = applied.sha;
          }
        }
        if (transition.output === null) {
          if (!isStepName(transition.to)) {
            return;
          }
          if (current) {
            throw new Error(`check ${current.step} is still open`);
          }
          const id = await deps.github.startCheck({
            owner: event.owner,
            repo: event.repo,
            name: checkName(transition.to),
            sha,
          });
          current = { step: transition.to, id };
          return;
        }
        if (!current || current.step !== transition.output.step) {
          throw new Error(`no open check for ${transition.output.step}`);
        }
        const open: { readonly step: string; readonly id: number } = current;
        await deps.github.finishCheck({
          owner: event.owner,
          repo: event.repo,
          checkRunId: open.id,
          conclusion: "success",
          summary: transition.output.summary,
        });
        current = null;
        steps.push({
          step: open.step,
          conclusion: "success",
          summary: transition.output.summary,
        });
      },
    });

    const pullRequest = await deps.github.openDraft({
      owner: event.owner,
      repo: event.repo,
      title: capture.pullRequest?.title ?? `thin-pr #${event.issueNumber}`,
      head: branch,
      base: event.defaultBranch,
      body: formatDraftBody(capture, formatRunReport({
        runId: deps.runId,
        templateId: deps.template.id,
        issueNumber: event.issueNumber,
        branch,
        error: "",
        steps,
      })),
      draft: true,
    });
    return { status: "completed", branch, headSha, checks: [...steps], pullRequest };
  } catch (error) {
    const message = errorText(error);
    if (current) {
      const open: { readonly step: string; readonly id: number } = current;
      let summary = message;
      try {
        await deps.github.finishCheck({
          owner: event.owner,
          repo: event.repo,
          checkRunId: open.id,
          conclusion: "failure",
          summary: message,
        });
      } catch (checkError) {
        summary = `${message}; check update failed: ${errorText(checkError)}`;
      }
      steps.push({ step: open.step, conclusion: "failure", summary });
      current = null;
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
  readonly gates?: Readonly<Record<string, GateHook>>;
  readonly model?: ModelClient;
  readonly changes?: readonly FileChange[];
}): Promise<LabelRunResult> {
  const event = readLabelEvent(input.payload);
  const log = openEventLog(input.logPath);
  const capture = createRunCapture();
  try {
    return await runOnLabel(event, {
      github: input.github,
      template: loadTemplate(join(input.workspace, "templates", "small-feature.yaml")),
      specialists: createStubSpecialists(input.model, capture),
      gates: input.gates,
      capture,
      changes: input.changes,
      budget: parseBudget(JSON.parse(readFileSync(join(input.workspace, "evals", "budget.json"), "utf8"))),
      log,
      runId: input.runId,
    });
  } finally {
    log.close();
  }
}

async function applyImplementDiff(
  deps: LabelRunDeps,
  event: LabelEvent,
  baseSha: string,
  branch: string,
  capture: CapturedRun,
): Promise<{ readonly evidence: RunnerEvidence; readonly sha: string | null }> {
  const changes = await collectChanges(deps, event, baseSha, capture);
  const diff = measureDiff(changes);
  const testsPassed =
    diff.meaningful &&
    confirmSources(
      changes
        .filter((change) => change.before !== change.after)
        .map((change) => ({ path: change.path, source: change.after })),
    );
  const evidence: RunnerEvidence = { diff, testsPassed, budget: deps.budget };
  const withinBudget = diff.files <= deps.budget.maxFiles && diff.lines <= deps.budget.maxLines;
  if (!diff.meaningful || !withinBudget) {
    return { evidence, sha: null };
  }
  const files = changes
    .filter((change) => change.before !== change.after)
    .map((change) => ({ path: change.path, content: change.after }));
  const sha = await deps.github.commitFiles({
    owner: event.owner,
    repo: event.repo,
    branch,
    parentSha: baseSha,
    message: `Apply thin-pr/#${event.issueNumber}`,
    files,
  });
  return { evidence, sha };
}

async function collectChanges(
  deps: LabelRunDeps,
  event: LabelEvent,
  baseSha: string,
  capture: CapturedRun,
): Promise<readonly FileChange[]> {
  if (deps.changes) {
    return deps.changes;
  }
  const edits = capture.implement?.edits ?? [];
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

function safeRelative(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
}

async function applyRules(
  deps: LabelRunDeps,
  event: LabelEvent,
  sha: string,
  capture: CapturedRun,
  steps: StepReport[],
  evidence: RunnerEvidence,
): Promise<"pass" | "fail"> {
  const results = evaluate(capture, evidence);
  for (const result of results) {
    await postRule(deps, event, sha, result, steps);
  }
  return decide(capture, evidence);
}

async function postRule(
  deps: LabelRunDeps,
  event: LabelEvent,
  sha: string,
  result: GateRuleResult,
  steps: StepReport[],
): Promise<void> {
  const summary = `${result.verdict}: ${result.reason}`;
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
    conclusion: result.verdict === "PASS" ? "success" : "failure",
    summary,
    title: result.verdict,
  });
  steps.push({
    step: `gate/${result.rule}`,
    conclusion: result.verdict === "PASS" ? "success" : "failure",
    summary,
  });
}

function formatDraftBody(capture: CapturedRun, report: string): string {
  return ["## Plan", "", formatPlan(capture.plan), "", "## Test results", "", formatTests(capture.test), "", report].join(
    "\n",
  );
}

function formatPlan(plan: CapturedRun["plan"]): string {
  if (!plan) {
    return "Plan is missing.";
  }
  const steps = plan.steps.map((step) => `- ${step}`).join("\n");
  return steps.length === 0 ? plan.summary : `${plan.summary}\n\n${steps}`;
}

function formatTests(test: CapturedRun["test"]): string {
  if (!test) {
    return "Test result is missing.";
  }
  const result = test.passed ? "Tests passed." : "Tests did not pass.";
  return `${test.summary}\n\n${result}`;
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
