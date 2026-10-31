import { decide } from "@thin-pr/gate";

export const packageId = "@thin-pr/specialists" as const;

export const STUB_STEPS = ["plan", "implement", "test", "review", "gate"] as const;

export type StubStep = (typeof STUB_STEPS)[number];

export type SpecialistDescriptor = {
  readonly id: StubStep;
};

export type StubOutput = {
  readonly step: StubStep;
  readonly summary: string;
};

export type StubInput = {
  readonly step: StubStep;
  readonly issue: string;
  readonly templateId: string;
  readonly prior: readonly StubOutput[];
};

export type StubSpecialist = {
  readonly step: StubStep;
  run(input: StubInput): StubOutput;
};

const FIXTURES = {
  plan: "Plan the stub change.",
  implement: "Apply the stub change.",
  test: "Stub checks passed.",
  review: "Stub review found nothing.",
} as const;

export function listSpecialists(): readonly SpecialistDescriptor[] {
  return STUB_STEPS.map((id) => ({ id }));
}

export function createStubSpecialists(): Record<StubStep, StubSpecialist> {
  return {
    plan: stub("plan"),
    implement: stub("implement"),
    test: stub("test"),
    review: stub("review"),
    gate: stub("gate"),
  };
}

function stub(step: StubStep): StubSpecialist {
  return {
    step,
    run(input) {
      if (input.step !== step) {
        throw new Error(`stub ${step} was called as ${input.step}`);
      }
      if (input.issue.length === 0) {
        throw new Error("issue is empty");
      }
      return {
        step,
        summary: step === "gate" ? decide() : FIXTURES[step],
      };
    },
  };
}
