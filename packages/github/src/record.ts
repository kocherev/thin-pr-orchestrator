import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunEvent, StepId, Usage } from "@thin-pr/core";
import type { GateRuleResult } from "@thin-pr/gate";
import { summaryOf, type CheckResult, type Diff } from "@thin-pr/specialists";
import type { LabelEvent } from "./event.js";

export type RunRecord = {
  readonly version: 1;
  readonly runId: string;
  readonly repo: string;
  readonly issue: { readonly number: number; readonly title: string; readonly url: string };
  readonly template: string;
  /** `cancelled` comes only from `/thin-pr cancel` on a run that waited for approval. */
  readonly status: "opened" | "awaiting_approval" | "blocked" | "failed" | "cancelled";
  readonly steps: readonly {
    readonly id: StepId;
    readonly attempt: number;
    readonly loop: number;
    readonly outcome: "finished" | "looped" | "failed";
    readonly startedAt: string;
    readonly durationMs: number;
    readonly usage: readonly Usage[];
    readonly summary: string;
  }[];
  readonly gate: readonly GateRuleResult[];
  readonly diff: Diff | null;
  readonly checks: readonly CheckResult[];
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
  readonly totals: {
    readonly costUsd: number;
    readonly durationMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
};

/** A run event and the time the orchestrator saw it. The log itself stores no clock. */
export type TimedEvent = { readonly event: RunEvent; readonly at: Date };

export function toRunRecord(run: {
  readonly runId: string;
  readonly event: LabelEvent;
  readonly template: string;
  readonly status: RunRecord["status"];
  readonly timeline: readonly TimedEvent[];
  readonly gate: readonly GateRuleResult[];
  readonly diff: Diff | null;
  readonly checks: readonly CheckResult[];
  readonly pullRequest: RunRecord["pullRequest"];
}): RunRecord {
  const steps: RunRecord["steps"][number][] = [];
  const passes: Partial<Record<StepId, number>> = {};
  let started: { readonly loop: number; readonly at: Date } | null = null;
  for (const { event, at } of run.timeline) {
    if (event.step === null) {
      continue;
    }
    if (event.kind === "started") {
      if (event.attempt === 1) {
        passes[event.step] = (passes[event.step] ?? -1) + 1;
      }
      started = { loop: passes[event.step] ?? 0, at };
      continue;
    }
    // Only a run completes, so a step event here is always finished, looped or failed.
    if (event.kind === "completed" || !started) {
      continue;
    }
    steps.push({
      id: event.step,
      attempt: event.attempt,
      loop: started.loop,
      outcome: event.kind,
      startedAt: started.at.toISOString(),
      durationMs: at.getTime() - started.at.getTime(),
      usage: event.usage,
      summary: event.error ?? event.feedback ?? summaryOf(event.output),
    });
    started = null;
  }

  const usage = steps.flatMap((step) => step.usage);
  const first = run.timeline[0]?.at;
  const last = run.timeline.at(-1)?.at;
  return {
    version: 1,
    runId: run.runId,
    repo: `${run.event.owner}/${run.event.repo}`,
    issue: { number: run.event.issue.number, title: run.event.issue.title, url: run.event.issue.url },
    template: run.template,
    status: run.status,
    steps,
    gate: run.gate,
    diff: run.diff,
    checks: run.checks,
    pullRequest: run.pullRequest,
    totals: {
      costUsd: usage.reduce((sum, item) => sum + item.costUsd, 0),
      durationMs: first && last ? last.getTime() - first.getTime() : 0,
      inputTokens: usage.reduce((sum, item) => sum + item.inputTokens, 0),
      outputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0),
    },
  };
}

/** Writes the record as JSON when a path is set, so a workflow can keep it. */
export function exportRunRecord(record: RunRecord, path: string | undefined): void {
  if (!path) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

/** The verdict the evals score. A run that failed before the gate, or was cancelled, counts as blocked. */
export type Verdict = "opened" | "awaiting_approval" | "blocked";

export function verdictOf(status: RunRecord["status"]): Verdict {
  return status === "failed" || status === "cancelled" ? "blocked" : status;
}
