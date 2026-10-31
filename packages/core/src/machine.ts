import type { EventLog, NewLogEvent } from "./log.js";
import type {
  LogEvent,
  Phase,
  RunState,
  Specialist,
  SpecialistMap,
  SpecialistOutput,
  WorkflowStep,
  WorkflowTemplate,
} from "./types.js";

export type GateHook = () => "pass" | "fail" | Promise<"pass" | "fail">;

export type Transition = {
  readonly from: Phase;
  readonly to: Phase;
  readonly output: SpecialistOutput | null;
};

export type RunInput = {
  readonly runId: string;
  readonly issue: string;
  readonly template: WorkflowTemplate;
  readonly specialists: SpecialistMap;
  readonly log: EventLog;
  readonly gates?: Readonly<Record<string, GateHook>>;
  readonly onTransition?: (transition: Transition) => void | Promise<void>;
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
    const specialist = input.specialists[step.specialist];
    if (!specialist) {
      throw new Error(`missing specialist for ${step.specialist}`);
    }

    phase = await record(input, phase, step.id, null);
    const output = await runStep(input, step, specialist, outputs);
    const next = input.template.steps[index + 1]?.id ?? "complete";
    phase = await record(input, phase, next, output);
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

async function runStep(
  input: RunInput,
  step: WorkflowStep,
  specialist: Specialist,
  outputs: readonly SpecialistOutput[],
): Promise<SpecialistOutput> {
  const attempts = step.retries + 1;
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const output = await specialist.run({
        step: step.id,
        issue: input.issue,
        templateId: input.template.id,
        prior: [...outputs],
      });
      if (output.step !== step.id) {
        throw new Error(`specialist for ${step.id} returned step ${output.step}`);
      }
      if (step.gate) {
        await applyGate(input.gates, step.gate);
      }
      return output;
    } catch (error) {
      last = error;
    }
  }
  if (last instanceof Error) {
    throw last;
  }
  throw new Error("step failed");
}

async function applyGate(gates: RunInput["gates"], name: string): Promise<void> {
  const hook = gates?.[name];
  if (!hook) {
    throw new Error(`missing gate hook ${name}`);
  }
  const decision = await hook();
  if (decision !== "pass") {
    throw new Error(`gate ${name} returned ${decision}`);
  }
}

async function record(
  input: RunInput,
  from: Phase,
  to: Phase,
  output: SpecialistOutput | null,
): Promise<Phase> {
  const event: NewLogEvent = {
    runId: input.runId,
    templateId: input.template.id,
    issue: input.issue,
    from,
    to,
    output,
  };
  input.log.append(event);
  await input.onTransition?.({ from, to, output });
  return to;
}
