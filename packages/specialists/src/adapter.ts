import { executeSpecialist, type ModelClient, type SpecialistName } from "./contract.js";
import {
  implementer,
  planner,
  prWriter,
  ReplayModelClient,
  reviewer,
  tester,
} from "./specialists.js";

export const STUB_STEPS = ["plan", "implement", "test", "review", "gate"] as const;

export type StubStep = (typeof STUB_STEPS)[number];

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
  run(input: StubInput): Promise<StubOutput>;
};

export type CapturedRun = {
  plan: { summary: string; steps: string[] } | null;
  implement: { summary: string; files: string[]; edits?: { path: string; content: string }[] } | null;
  test: { summary: string; passed: boolean } | null;
  review: { summary: string; notes: string[] } | null;
  pullRequest: { summary: string; title: string; body: string } | null;
};

export function createRunCapture(): CapturedRun {
  return {
    plan: null,
    implement: null,
    test: null,
    review: null,
    pullRequest: null,
  };
}

export function createStubSpecialists(
  model: ModelClient = new ReplayModelClient(),
  capture?: CapturedRun,
): Record<SpecialistName, StubSpecialist> {
  return {
    planner: adapt("plan", model, capture),
    implementer: adapt("implement", model, capture),
    tester: adapt("test", model, capture),
    reviewer: adapt("review", model, capture),
    "pr-writer": adapt("gate", model, capture),
  };
}

function adapt(step: StubStep, model: ModelClient, capture?: CapturedRun): StubSpecialist {
  return {
    step,
    async run(input) {
      const summary = await runStep(step, model, input, capture);
      return { step, summary };
    },
  };
}

async function runStep(
  step: StubStep,
  model: ModelClient,
  input: StubInput,
  capture?: CapturedRun,
): Promise<string> {
  const ctx = {
    workdir: ".",
    model,
    budget: { maxTokens: 2000, maxSeconds: 30 },
    log() {
      return undefined;
    },
  };
  const prior = (name: StubStep) => input.prior.find((item) => item.step === name)?.summary ?? "";

  switch (step) {
    case "plan": {
      const output = await executeSpecialist(planner, ctx, {
        issue: input.issue,
        templateId: input.templateId,
      });
      if (capture) {
        capture.plan = output;
      }
      return output.summary;
    }
    case "implement": {
      const output = await executeSpecialist(implementer, ctx, {
        issue: input.issue,
        planSummary: prior("plan"),
      });
      if (capture) {
        capture.implement = output;
      }
      return output.summary;
    }
    case "test": {
      const output = await executeSpecialist(tester, ctx, {
        issue: input.issue,
        changeSummary: prior("implement"),
      });
      if (capture) {
        capture.test = output;
      }
      return output.summary;
    }
    case "review": {
      const output = await executeSpecialist(reviewer, ctx, {
        issue: input.issue,
        testSummary: prior("test"),
      });
      if (capture) {
        capture.review = output;
      }
      return output.summary;
    }
    case "gate": {
      const output = await executeSpecialist(prWriter, ctx, {
        issue: input.issue,
        reviewSummary: prior("review"),
      });
      if (capture) {
        capture.pullRequest = output;
      }
      return output.summary;
    }
  }
}
