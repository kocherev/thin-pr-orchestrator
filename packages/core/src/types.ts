export const STEP_NAMES = ["plan", "implement", "test", "review", "gate"] as const;

export type StepName = (typeof STEP_NAMES)[number];

export type Phase = "idle" | StepName | "complete";

export type SpecialistOutput = {
  readonly step: StepName;
  readonly summary: string;
};

export type SpecialistInput = {
  readonly step: StepName;
  readonly issue: string;
  readonly templateId: string;
  readonly prior: readonly SpecialistOutput[];
};

export type Specialist = {
  run(input: SpecialistInput): SpecialistOutput;
};

export type SpecialistMap = Partial<Record<StepName, Specialist>>;

export type WorkflowTemplate = {
  readonly id: string;
  readonly steps: readonly StepName[];
};

export type RunState = {
  readonly runId: string;
  readonly templateId: string;
  readonly issue: string;
  readonly phase: Phase;
  readonly outputs: readonly SpecialistOutput[];
};

export type LogEvent = {
  readonly seq: number;
  readonly runId: string;
  readonly templateId: string;
  readonly issue: string;
  readonly from: Phase;
  readonly to: Phase;
  readonly output: SpecialistOutput | null;
};

export function isStepName(value: string): value is StepName {
  return (STEP_NAMES as readonly string[]).includes(value);
}

export function isPhase(value: string): value is Phase {
  return value === "idle" || value === "complete" || isStepName(value);
}
