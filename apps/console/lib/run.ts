import type { RunRecord, RunStep } from "./schema";

/** The eval cases replay recorded model responses against this repo. Its issue and PR links do not exist. */
const EVAL_SAMPLE_REPO = "example/sample-repo";

export const REPLAY_NOTE =
  "Replayed from recorded model responses. Costs and durations are recorded estimates until live recordings land.";

export function isReplay(run: RunRecord): boolean {
  return run.repo === EVAL_SAMPLE_REPO;
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
