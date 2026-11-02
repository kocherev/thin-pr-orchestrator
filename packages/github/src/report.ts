import type { Json, StepId } from "@thin-pr/core";
import { plannerOutput } from "@thin-pr/specialists";
import type { RunRecord } from "./record.js";
import { verifyOutput } from "./steps.js";

/** The `## Run report` the run comments on the issue, and the last section of the draft body. */
export function formatRunReport(record: RunRecord, branch: string, error: string | null): string {
  const lines = [
    "## Run report",
    "",
    `- Run: ${record.runId}`,
    `- Template: ${record.template}`,
    `- Issue: ${record.issue.number}`,
    `- Branch: ${branch}`,
  ];
  if (error) {
    lines.push(`- Error: ${error}`);
  }
  lines.push("", "### Steps");
  const steps = [
    ...record.steps.map((step) => `- ${step.id}: ${step.outcome === "finished" ? "success" : "failure"}. ${step.summary}`),
    ...record.gate.map(
      (rule) => `- gate/${rule.rule}: ${rule.verdict === "PASS" ? "success" : "failure"}. ${rule.verdict}: ${rule.reason}`,
    ),
  ];
  lines.push(...(steps.length === 0 ? ["", "No step finished."] : steps));
  return lines.join("\n");
}

export function formatDraftBody(outputs: Readonly<Partial<Record<StepId, Json>>>, report: string): string {
  return ["## Plan", "", formatPlan(outputs.plan), "", "## Checks", "", formatChecks(outputs.verify), "", report].join("\n");
}

function formatPlan(output: Json | undefined): string {
  const plan = plannerOutput.safeParse(output);
  if (!plan.success) {
    return "Plan is missing.";
  }
  return `${plan.data.summary}\n\n${plan.data.steps.map((step) => `- ${step}`).join("\n")}`;
}

function formatChecks(output: Json | undefined): string {
  const verify = verifyOutput.safeParse(output);
  if (!verify.success) {
    return "Checks did not run.";
  }
  return verify.data.checks
    .map((check) => `- ${check.name}: exit ${check.exitCode} in ${check.durationMs} ms. \`${check.command}\``)
    .join("\n");
}
