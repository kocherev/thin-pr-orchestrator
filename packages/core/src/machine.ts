import type { EventLog, NewLogEvent } from "./log.js";
import type {
  LogEvent,
  Phase,
  RunState,
  SpecialistMap,
  SpecialistOutput,
  WorkflowTemplate,
} from "./types.js";

export type RunInput = {
  readonly runId: string;
  readonly issue: string;
  readonly template: WorkflowTemplate;
  readonly specialists: SpecialistMap;
  readonly log: EventLog;
};

export async function runWorkflow(input: RunInput): Promise<RunState> {
  if (input.runId.length === 0) {
    throw new Error("runId must be a non-empty string");
  }
  if (input.issue.length === 0) {
    throw new Error("issue must be a non-empty string");
  }
  if (input.template.steps.length === 0) {
    throw new Error("template steps must be a non-empty list");
  }

  let phase: Phase = "idle";
  const outputs: SpecialistOutput[] = [];

  for (let index = 0; index < input.template.steps.length; index += 1) {
    const step = input.template.steps[index];
    if (!step) {
      throw new Error("template step is missing");
    }
    const specialist = input.specialists[step];
    if (!specialist) {
      throw new Error(`missing specialist for ${step}`);
    }

    phase = record(input, phase, step, null);
    const output = await specialist.run({
      step,
      issue: input.issue,
      templateId: input.template.id,
      prior: [...outputs],
    });
    if (output.step !== step) {
      throw new Error(`specialist for ${step} returned step ${output.step}`);
    }
    const next = input.template.steps[index + 1] ?? "complete";
    phase = record(input, phase, next, output);
    outputs.push(output);
  }

  return {
    runId: input.runId,
    templateId: input.template.id,
    issue: input.issue,
    phase,
    outputs,
  };
}

export function replay(events: readonly LogEvent[]): RunState {
  const first = events[0];
  if (!first) {
    throw new Error("cannot replay an empty log");
  }

  let state: RunState = {
    runId: first.runId,
    templateId: first.templateId,
    issue: first.issue,
    phase: "idle",
    outputs: [],
  };

  for (const event of events) {
    if (
      event.runId !== state.runId ||
      event.templateId !== state.templateId ||
      event.issue !== state.issue
    ) {
      throw new Error(`event ${event.seq} belongs to a different run`);
    }
    if (event.from !== state.phase) {
      throw new Error(
        `event ${event.seq} starts at ${event.from}, current phase is ${state.phase}`,
      );
    }
    if (event.output && event.output.step !== event.from) {
      throw new Error(`event ${event.seq} output does not match phase ${event.from}`);
    }
    state = {
      ...state,
      phase: event.to,
      outputs: event.output ? [...state.outputs, event.output] : state.outputs,
    };
  }

  return state;
}

function record(
  input: RunInput,
  from: Phase,
  to: Phase,
  output: SpecialistOutput | null,
): Phase {
  const event: NewLogEvent = {
    runId: input.runId,
    templateId: input.template.id,
    issue: input.issue,
    from,
    to,
    output,
  };
  input.log.append(event);
  return to;
}
