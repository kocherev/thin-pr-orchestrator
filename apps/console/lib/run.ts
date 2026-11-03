import { joinWords, RULE_LABEL, STEP_LABEL } from "./labels";
import type { RunRecord, RunStep } from "./schema";

/** The eval cases replay recorded model responses against these repos. Their issue and PR links do not exist. */
const EVAL_SAMPLE_REPOS = new Set(["example/sample-repo", "example/sample-python"]);

export const REPLAY_NOTE =
  "Replayed from recorded model responses. Costs and durations are recorded estimates until live recordings land.";

export function isReplay(run: RunRecord): boolean {
  return EVAL_SAMPLE_REPOS.has(run.repo);
}

export function runStartedAt(run: RunRecord): string | null {
  return run.steps[0]?.startedAt ?? null;
}

export function gateSummary(run: RunRecord): { passed: number; total: number } {
  return {
    passed: run.gate.filter((result) => result.verdict === "PASS").length,
    total: run.gate.length,
  };
}

export const APPROVE_COMMAND = "/thin-pr approve";

/** Loop feedback and planner errors carry a log. The first line names the failure. */
export function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

export type Outcome = {
  /** A few words for the runs table. */
  short: string;
  /** One sentence that says why the run ended the way it did. */
  headline: string;
  /** The gate reason or step summary behind the headline. */
  detail: string | null;
};

/** Explains a run's status from the gate rules and steps that decided it. */
export function runOutcome(run: RunRecord): Outcome {
  switch (run.status) {
    case "opened":
      return {
        short: `${run.gate.length}/${run.gate.length} passed`,
        headline: `All ${run.gate.length} gate rules passed, so a draft pull request opened.`,
        detail: null,
      };
    case "awaiting_approval": {
      const waiting = run.gate.filter((result) => result.verdict === "NEEDS_APPROVAL");
      const names = joinWords(waiting.map((result) => RULE_LABEL[result.rule].toLowerCase()));
      return {
        short: `Over ${names}`,
        headline: `Waiting for approval. Every other rule passed, but the change is over its ${names}.`,
        detail: waiting[0]?.reason ?? null,
      };
    }
    case "blocked": {
      const failed = run.gate.filter((result) => result.verdict === "FAIL");
      const names = joinWords(failed.map((result) => RULE_LABEL[result.rule]));
      return {
        short: `${names} failed`,
        headline: `Blocked because ${failed.length === 1 ? "one gate rule" : `${failed.length} gate rules`} failed: ${names}.`,
        detail: failed[0]?.reason ?? null,
      };
    }
    case "failed": {
      const step = run.steps.findLast((candidate) => candidate.outcome === "failed");
      const where = step ? STEP_LABEL[step.id].toLowerCase() : "first";
      return {
        short: `Stopped at ${where}`,
        headline: `Stopped at the ${where} step, before the gate could run.`,
        detail: step ? firstLine(step.summary) : null,
      };
    }
    case "cancelled":
      return {
        short: "Cancelled",
        headline: "Cancelled while it waited for approval, so its branch was deleted and no draft opened.",
        detail: null,
      };
  }
}

export function stepUsage(step: RunStep) {
  return {
    models: [...new Set(step.usage.map((usage) => usage.model))],
    requests: step.usage.length,
    inputTokens: step.usage.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: step.usage.reduce((sum, usage) => sum + usage.outputTokens, 0),
    costUsd: step.usage.reduce((sum, usage) => sum + usage.costUsd, 0),
  };
}

export type TimelineRow = { step: RunStep; offset: number; width: number };

/** Places every step attempt on one time axis that starts at the first step. */
export function timeline(run: RunRecord): { spanMs: number; rows: TimelineRow[] } {
  const starts = run.steps.map((step) => Date.parse(step.startedAt));
  const origin = Math.min(...starts);
  const end = Math.max(...run.steps.map((step, index) => (starts[index] ?? origin) + step.durationMs));
  const spanMs = Math.max(end - origin, 1);
  const rows = run.steps.map((step, index) => ({
    step,
    offset: ((starts[index] ?? origin) - origin) / spanMs,
    width: step.durationMs / spanMs,
  }));
  return { spanMs, rows };
}
