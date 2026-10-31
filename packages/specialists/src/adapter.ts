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

export function createStubSpecialists(
  model: ModelClient = new ReplayModelClient(),
): Record<SpecialistName, StubSpecialist> {
  return {
    planner: adapt("plan", model),
    implementer: adapt("implement", model),
    tester: adapt("test", model),
    reviewer: adapt("review", model),
    "pr-writer": adapt("gate", model),
  };
}

function adapt(step: StubStep, model: ModelClient): StubSpecialist {
  return {
    step,
    async run(input) {
      const summary = await runStep(step, model, input);
      return { step, summary };
    },
  };
}

async function runStep(step: StubStep, model: ModelClient, input: StubInput): Promise<string> {
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
      return output.summary;
    }
    case "implement": {
      const output = await executeSpecialist(implementer, ctx, {
        issue: input.issue,
        planSummary: prior("plan"),
      });
      return output.summary;
    }
    case "test": {
      const output = await executeSpecialist(tester, ctx, {
        issue: input.issue,
        changeSummary: prior("implement"),
      });
      return output.summary;
    }
    case "review": {
      const output = await executeSpecialist(reviewer, ctx, {
        issue: input.issue,
        testSummary: prior("test"),
      });
      return output.summary;
    }
    case "gate": {
      const output = await executeSpecialist(prWriter, ctx, {
        issue: input.issue,
        reviewSummary: prior("review"),
      });
      return output.summary;
    }
  }
}
