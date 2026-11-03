import type { Json, StepId, Usage } from "@thin-pr/core";
import type { GateRuleResult } from "@thin-pr/gate";
import { plannerOutput, reviewerOutput, type CheckResult } from "@thin-pr/specialists";
import type { RunRecord } from "./record.js";

const CELL_CHARS = 160;

/**
 * The draft pull request body when the gate passes, and the issue comment otherwise. Both lead with the outcome
 * and the gate table, then the usage, then collapsible sections for the plan, the checks, the review, and the steps.
 */
export function formatRunReport(run: {
  readonly record: RunRecord;
  readonly outputs: Readonly<Partial<Record<StepId, Json>>>;
  readonly branch: string;
  readonly error: string | null;
}): string {
  const { record } = run;
  return [
    outcome(record, run.error),
    gateTable(record.gate),
    usage(record),
    planSection(run.outputs.plan),
    checksSection(record.checks),
    reviewSection(run.outputs.review),
    stepsSection(record, run.branch),
  ].join("\n\n");
}

function outcome(record: RunRecord, error: string | null): string {
  const failed = record.gate.filter((rule) => rule.verdict === "FAIL").map((rule) => `\`${rule.rule}\``);
  switch (record.status) {
    case "opened":
      return `**Gate passed.** All ${record.gate.length} rules passed for #${record.issue.number}.`;
    case "blocked":
      return `**Gate failed.** ${failed.length} of ${record.gate.length} rules failed: ${failed.join(", ")}. Nothing was pushed.`;
    case "failed": {
      const [first = "", ...rest] = (error ?? "").split("\n");
      const line = `**Run failed.** ${first || "The run stopped before the gate."}`;
      const detail = rest.join("\n").trim();
      return detail.length > 0 ? `${line}\n\n${fenced(detail)}` : line;
    }
  }
}

// Failing rules come first, so a reviewer reads the reason before the passes.
function gateTable(gate: readonly GateRuleResult[]): string {
  if (gate.length === 0) {
    return "The gate did not run.";
  }
  const rows = [...gate]
    .sort((a, b) => Number(a.verdict === "PASS") - Number(b.verdict === "PASS"))
    .map((rule) => `| \`${rule.rule}\` | ${rule.verdict === "FAIL" ? "**FAIL**" : "PASS"} | ${cell(rule.reason)} |`);
  return ["| Rule | Verdict | Reason |", "| --- | --- | --- |", ...rows].join("\n");
}

function usage(record: RunRecord): string {
  const { totals } = record;
  const byModel = new Map<string, Usage[]>();
  for (const call of record.steps.flatMap((step) => step.usage)) {
    byModel.set(call.model, [...(byModel.get(call.model) ?? []), call]);
  }
  const models = [...byModel].map(([model, calls]) => {
    const sum = (field: "costUsd" | "inputTokens" | "outputTokens" | "durationMs") =>
      calls.reduce((total, call) => total + call[field], 0);
    return `- \`${model}\`: ${count(calls.length, "request")}, ${usd(sum("costUsd"))}, ${tokens(sum("inputTokens"), sum("outputTokens"))}, ${duration(sum("durationMs"))} in requests.`;
  });
  const run = `Run: ${usd(totals.costUsd)}, ${tokens(totals.inputTokens, totals.outputTokens)}, ${duration(totals.durationMs)} end to end.`;
  return [run, ...models].join("\n");
}

function planSection(output: Json | undefined): string {
  const plan = plannerOutput.safeParse(output);
  if (!plan.success) {
    return details("Plan", "The plan is missing.");
  }
  return details("Plan", `${plan.data.summary}\n\n${bullets(plan.data.steps)}`);
}

// Opens by default when a check failed, so the failing log is one click closer.
function checksSection(checks: readonly CheckResult[]): string {
  if (checks.length === 0) {
    return details("Checks", "The checks did not run.");
  }
  const summary = `Checks: ${checks.map((check) => `${check.name} exit ${check.exitCode}`).join(", ")}`;
  const body = checks.map(
    (check) =>
      `\`${check.name}\` exited ${check.exitCode} in ${duration(check.durationMs)}: \`${check.command}\`\n\n${fenced(check.logTail || "(no output)")}`,
  );
  return details(summary, body.join("\n\n"), checks.some((check) => check.exitCode !== 0));
}

function reviewSection(output: Json | undefined): string {
  const review = reviewerOutput.safeParse(output);
  if (!review.success) {
    return details("Review", "The review is missing.");
  }
  const notes = review.data.notes.length > 0 ? bullets(review.data.notes) : "No notes.";
  return details(`Review: ${review.data.verdict}`, `${review.data.summary}\n\n${notes}`);
}

function stepsSection(record: RunRecord, branch: string): string {
  const loops = record.steps.filter((step) => step.outcome === "looped").length;
  const retries = record.steps.filter((step) => step.attempt > 1).length;
  const summary = `Run report: ${count(record.steps.length, "step run")}, ${count(loops, "loop")}, ${count(retries, "retry", "retries")}`;
  const header = `Run \`${record.runId}\`, template \`${record.template}\`, issue #${record.issue.number}, branch \`${branch}\`.`;
  if (record.steps.length === 0) {
    return details(summary, `${header}\n\nNo step ran.`);
  }
  const rows = record.steps.map((step) => {
    const cost = usd(step.usage.reduce((total, call) => total + call.costUsd, 0));
    return `| ${step.id} | ${step.attempt} | ${step.loop} | ${step.outcome} | ${duration(step.durationMs)} | ${cost} | ${cell(step.summary)} |`;
  });
  const table = ["| Step | Attempt | Loop | Outcome | Duration | Cost | Summary |", "| --- | --- | --- | --- | --- | --- | --- |", ...rows];
  return details(summary, `${header}\n\n${table.join("\n")}`);
}

function details(summary: string, body: string, open = false): string {
  return [`<details${open ? " open" : ""}>`, `<summary>${summary}</summary>`, "", body, "", "</details>"].join("\n");
}

// A fence one backtick longer than any run of backticks in the text, so a log cannot close it early.
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text.trimEnd()}\n${fence}`;
}

// A table cell is one short line, and a pipe would end it.
function cell(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const short = line.length > CELL_CHARS ? `${line.slice(0, CELL_CHARS - 3)}...` : line;
  return short.replaceAll("|", "\\|");
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

function usd(value: number): string {
  return `${value.toFixed(6)} USD`;
}

function tokens(input: number, output: number): string {
  return `${input.toLocaleString("en-US")} input and ${output.toLocaleString("en-US")} output tokens`;
}

function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
