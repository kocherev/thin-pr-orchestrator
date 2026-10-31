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
import { decide } from "@thin-pr/gate";
import { createStubSpecialists } from "@thin-pr/specialists";
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
    `- Error: ${report.error}`,
    "",
    "### Steps",
  ];
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

  try {
    headSha = await deps.github.branchSha(event.owner, event.repo, event.defaultBranch);
    branch = branchName(event.issueNumber);
    await deps.github.createBranch(event.owner, event.repo, branch, headSha);
    const sha = headSha;

    await runWorkflow({
      runId: deps.runId,
      issue: event.issueText,
      template: deps.template,
      specialists: deps.specialists,
      gates: deps.gates,
      log: deps.log,
      async onTransition(transition) {
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

    return { status: "completed", branch, headSha, checks: [...steps] };
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
}): Promise<LabelRunResult> {
  const event = readLabelEvent(input.payload);
  const log = openEventLog(input.logPath);
  try {
    return await runOnLabel(event, {
      github: input.github,
      template: loadTemplate(join(input.workspace, "templates", "small-feature.yaml")),
      specialists: createStubSpecialists(),
      gates: input.gates ?? { decide },
      log,
      runId: input.runId,
    });
  } finally {
    log.close();
  }
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
