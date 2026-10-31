import { describe, expect, it } from "vitest";
import {
  createStepContext,
  executeSpecialist,
  type Specialist,
  SpecialistSchemaError,
  type StepContext,
} from "./contract.js";
import {
  FIXTURES,
  implementer,
  planner,
  prWriter,
  ReplayModelClient,
  reviewer,
  tester,
} from "./specialists.js";

const inputFor = {
  planner: { issue: "Fix the stub.", templateId: "stub-run" },
  implementer: { issue: "Fix the stub.", planSummary: "Plan the stub change." },
  tester: { issue: "Fix the stub.", changeSummary: "Apply the stub change." },
  reviewer: { issue: "Fix the stub.", testSummary: "Stub checks passed." },
  "pr-writer": { issue: "Fix the stub.", reviewSummary: "Stub review found nothing." },
} as const;

describe("specialist schemas", () => {
  it("accepts the replay fixture for each specialist", async () => {
    const ctx = createStepContext(new ReplayModelClient());
    await expectFixture(planner, ctx, inputFor.planner);
    await expectFixture(implementer, ctx, inputFor.implementer);
    await expectFixture(tester, ctx, inputFor.tester);
    await expectFixture(reviewer, ctx, inputFor.reviewer);
    await expectFixture(prWriter, ctx, inputFor["pr-writer"]);
  });

  it("fails output validation and reports the schema path", async () => {
    const ctx = createStepContext(
      new ReplayModelClient({
        reviewer: JSON.stringify({ summary: "Stub review found nothing.", notes: [1] }),
      }),
    );

    const error = await executeSpecialist(reviewer, ctx, inputFor.reviewer).then(
      () => {
        throw new Error("expected reviewer output to fail");
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SpecialistSchemaError);
    if (!(error instanceof SpecialistSchemaError)) {
      throw new Error("expected SpecialistSchemaError");
    }
    expect(error.specialist).toBe("reviewer");
    expect(error.phase).toBe("output");
    expect(error.path).toBe("notes.0");
    expect(error.message).toBe(
      "reviewer output invalid at notes.0: Invalid input: expected string, received number",
    );
  });

  it("rejects input before the model is called", async () => {
    let calls = 0;
    const ctx = createStepContext({
      async complete() {
        calls += 1;
        return JSON.stringify(FIXTURES.planner);
      },
    });

    const error = await executeSpecialist(planner, ctx, { issue: "", templateId: "stub-run" }).then(
      () => {
        throw new Error("expected planner input to fail");
      },
      (caught: unknown) => caught,
    );

    expect(calls).toBe(0);
    expect(error).toBeInstanceOf(SpecialistSchemaError);
    if (!(error instanceof SpecialistSchemaError)) {
      throw new Error("expected SpecialistSchemaError");
    }
    expect(error.phase).toBe("input");
    expect(error.path).toBe("issue");
    expect(error.message).toContain("planner input invalid at issue");
  });
});

async function expectFixture<I, O>(
  specialist: Specialist<I, O>,
  ctx: StepContext,
  input: I,
): Promise<void> {
  const output = await executeSpecialist(specialist, ctx, input);
  expect(output).toEqual(FIXTURES[specialist.name]);
}
