import type { Span } from "@opentelemetry/api";
import type { EventLog, NewRunEvent } from "./log.js";
import { usageAttributes, withSpan } from "./span.js";
import type { Template, TemplateStep } from "./template.js";
import type { RunEvent, RunState, StepHandler, StepId, StepResult, Usage } from "./types.js";

type RunInput = {
  readonly runId: string;
  readonly issue: string;
  readonly template: Template;
  readonly handlers: Readonly<Record<StepId, StepHandler>>;
  readonly log: EventLog;
  readonly onEvent?: (event: RunEvent) => void | Promise<void>;
};

/** A step that ran out of retries or loops. The run records it and stops. */
class StepFailure extends Error {}

/**
 * A failed attempt. The `failed` event keeps its usage, so the run totals count it. `retryable: false` stops the
 * run at once, for a failure that another attempt would hit too, such as a spend limit.
 */
export class StepError extends Error {
  readonly usage: readonly Usage[];
  readonly retryable: boolean;

  constructor(cause: unknown, usage: readonly Usage[], options: { readonly retryable?: boolean } = {}) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "StepError";
    this.usage = usage;
    this.retryable = options.retryable ?? true;
  }
}

export async function runWorkflow(input: RunInput): Promise<RunState> {
  const { runId, issue, template, handlers, log } = input;
  if (runId.length === 0) {
    throw new Error("runId must be a non-empty string");
  }
  if (issue.length === 0) {
    throw new Error("issue must be a non-empty string");
  }

  let state: RunState | null = null;
  const emit = async (event: Partial<NewRunEvent> & Pick<NewRunEvent, "kind">): Promise<RunState> => {
    const stored = log.append({
      runId,
      templateId: template.id,
      step: null,
      attempt: 0,
      output: null,
      feedback: null,
      usage: [],
      error: null,
      ...event,
    });
    state = state === null ? start(stored) : apply(state, stored);
    await input.onEvent?.(stored);
    return state;
  };

  // Runs one pass over a step with its retries. Returns the loop target and its feedback, or null to move on.
  const runPass = async (step: TemplateStep, loop: number, feedback: string | null, span: Span) => {
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= step.retries + 1; attempt += 1) {
      span.setAttribute("thin_pr.attempts", attempt);
      const attemptFeedback = lastError ?? feedback;
      const current = await emit({ step: step.id, kind: "started", attempt, feedback: attemptFeedback });
      let result: StepResult;
      try {
        result = await handlers[step.id]({
          runId,
          issue,
          step,
          outputs: current.outputs,
          feedback: attemptFeedback,
          attempt,
          loop,
        });
      } catch (error) {
        lastError = error instanceof Error && error.message.length > 0 ? error.message : "step failed";
        const usage = error instanceof StepError ? error.usage : [];
        await emit({ step: step.id, kind: "failed", attempt, error: lastError, usage });
        if (error instanceof StepError && !error.retryable) {
          throw new StepFailure(`${step.id} stopped: ${lastError}`);
        }
        continue;
      }

      const usage = result.usage ?? [];
      if (result.outcome === "done") {
        await emit({ step: step.id, kind: "finished", attempt, output: result.output, usage });
        return null;
      }
      const looped = { step: step.id, attempt, output: result.output, feedback: result.feedback, usage };
      if (!step.loop || (current.loops[step.id] ?? 0) >= step.loop.max) {
        const error = `${step.id} reached its loop limit (${step.loop?.max ?? 0})`;
        await emit({ ...looped, kind: "failed", error });
        throw new StepFailure(error);
      }
      await emit({ ...looped, kind: "looped" });
      return { backTo: step.loop.back_to, feedback: result.feedback };
    }
    throw new StepFailure(`${step.id} failed after ${step.retries + 1} ${step.retries === 0 ? "attempt" : "attempts"}: ${lastError}`);
  };

  await emit({ kind: "started", output: { issue } });
  try {
    await withSpan("thin-pr.run", { "thin_pr.run_id": runId, "thin_pr.template_id": template.id }, async (runSpan) => {
      const passes: Partial<Record<StepId, number>> = {};
      let feedback: string | null = null;
      let index = 0;
      try {
        while (index < template.steps.length) {
          const step = template.steps[index];
          if (!step) {
            throw new Error(`template step ${index} is missing`);
          }
          const loop = passes[step.id] ?? 0;
          passes[step.id] = loop + 1;
          const next = await withSpan(`thin-pr.${step.id}`, { "thin_pr.step": step.id, "thin_pr.loop": loop }, async (span) => {
            const before = state?.usage.length ?? 0;
            try {
              return await runPass(step, loop, feedback, span);
            } finally {
              span.setAttributes(usageAttributes(state?.usage.slice(before) ?? []));
            }
          });
          feedback = next?.feedback ?? null;
          index = next ? template.steps.findIndex((candidate) => candidate.id === next.backTo) : index + 1;
        }
      } finally {
        runSpan.setAttributes(usageAttributes(state?.usage ?? []));
      }
    });
  } catch (error) {
    if (!(error instanceof StepFailure)) {
      throw error;
    }
    return emit({ kind: "failed", error: error.message });
  }
  return emit({ kind: "completed" });
}

/** Folds a stored log back into the state `runWorkflow` returned. */
export function replay(events: readonly RunEvent[]): RunState {
  const [first, ...rest] = events;
  if (!first) {
    throw new Error("cannot replay an empty log");
  }
  return rest.reduce(apply, start(first));
}

function start(event: RunEvent): RunState {
  const output = event.output;
  if (event.step !== null || event.kind !== "started" || !isRecord(output) || typeof output.issue !== "string") {
    throw new Error(`event ${event.seq} is not the start of a run`);
  }
  return {
    runId: event.runId,
    templateId: event.templateId,
    issue: output.issue,
    status: "running",
    outputs: {},
    loops: {},
    usage: [],
  };
}

function apply(state: RunState, event: RunEvent): RunState {
  if (event.runId !== state.runId || event.templateId !== state.templateId) {
    throw new Error(`event ${event.seq} belongs to a different run`);
  }
  if (state.status !== "running") {
    throw new Error(`event ${event.seq} comes after the run ${state.status}`);
  }
  const step = event.step;
  if (step === null) {
    if (event.kind === "completed" || event.kind === "failed") {
      return { ...state, status: event.kind };
    }
    throw new Error(`event ${event.seq} is a run-level ${event.kind}`);
  }
  const usage = [...state.usage, ...event.usage];
  switch (event.kind) {
    case "started":
      return state;
    case "failed":
      return { ...state, usage };
    case "finished":
      return { ...state, outputs: { ...state.outputs, [step]: event.output }, usage };
    case "looped":
      return {
        ...state,
        outputs: { ...state.outputs, [step]: event.output },
        loops: { ...state.loops, [step]: (state.loops[step] ?? 0) + 1 },
        usage,
      };
    case "completed":
      throw new Error(`event ${event.seq} completes a step; only a run completes`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
