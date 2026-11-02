import type { TemplateStep } from "./template.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const STEP_IDS = ["plan", "implement", "verify", "review", "write"] as const;

export type StepId = (typeof STEP_IDS)[number];

export type Usage = {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
};

export type StepResult =
  | { readonly outcome: "done"; readonly output: Json; readonly usage?: readonly Usage[] }
  | { readonly outcome: "loop"; readonly output: Json; readonly feedback: string; readonly usage?: readonly Usage[] };

export type StepContext = {
  readonly runId: string;
  readonly issue: string;
  readonly step: TemplateStep;
  readonly outputs: Readonly<Partial<Record<StepId, Json>>>;
  /** Loop feedback on the first attempt of a pass, the previous error on a retry, otherwise null. */
  readonly feedback: string | null;
  /** 1 on the first try of a pass. */
  readonly attempt: number;
  /** How many times the run has looped back over this step. */
  readonly loop: number;
};

export type StepHandler = (context: StepContext) => Promise<StepResult>;

/**
 * One row of the run log. `step` is null for run-level events: `started` (its output is `{ issue }`),
 * `completed`, and `failed`.
 */
export type RunEvent = {
  readonly seq: number;
  readonly runId: string;
  readonly templateId: string;
  readonly step: StepId | null;
  readonly kind: "started" | "finished" | "looped" | "failed" | "completed";
  readonly attempt: number;
  readonly output: Json | null;
  readonly feedback: string | null;
  readonly usage: readonly Usage[];
  readonly error: string | null;
};

export type RunState = {
  readonly runId: string;
  readonly templateId: string;
  readonly issue: string;
  readonly status: "running" | "completed" | "failed";
  readonly outputs: Readonly<Partial<Record<StepId, Json>>>;
  /** Loops taken, keyed by the step that asked for them. */
  readonly loops: Readonly<Partial<Record<StepId, number>>>;
  readonly usage: readonly Usage[];
};
