import type { Json, StepContext, StepId } from "@thin-pr/core";
import { describe, expect, it } from "vitest";
import { createStepHandlers, ReplayModelClient, SpecialistSchemaError, type ModelClient } from "./index.js";

describe("step handlers", () => {
  it("returns the parsed reply for each model step", async () => {
    const handlers = createStepHandlers(new ReplayModelClient());
    const outputs: Partial<Record<StepId, Json>> = { verify: { summary: "typecheck passed; test passed." } };
    for (const step of ["plan", "implement", "review", "write"] as const) {
      const result = await handlers[step](context(step, outputs));
      expect(result.outcome).toBe("done");
      outputs[step] = result.output;
    }
    expect(outputs).toEqual({
      plan: { summary: "Plan the stub change.", steps: ["edit the stub"] },
      implement: { summary: "Apply the stub change.", files: ["src/stub.ts"] },
      verify: { summary: "typecheck passed; test passed." },
      review: { summary: "Stub review found nothing.", notes: [] },
      write: { summary: "pass", title: "Fix the stub", body: "Stub draft." },
    });
  });

  it("sends the previous summary and the feedback to the model", async () => {
    const prompts: string[] = [];
    const model: ModelClient = {
      async complete(request) {
        prompts.push(request.prompt);
        return new ReplayModelClient().complete(request);
      },
    };
    await createStepHandlers(model).implement({
      ...context("implement", { plan: { summary: "Clamp at zero.", steps: ["edit"] } }),
      feedback: "implementer output invalid at files",
    });
    expect(JSON.parse(prompts[0] ?? "")).toEqual({
      input: { issue: "Fix the stub.", planSummary: "Clamp at zero." },
      feedback: "implementer output invalid at files",
    });
  });

  it("fails output validation and reports the schema path", async () => {
    const handlers = createStepHandlers(
      new ReplayModelClient({ reviewer: JSON.stringify({ summary: "Stub review found nothing.", notes: [1] }) }),
    );
    const error = await handlers.review(context("review", { verify: { summary: "Stub checks passed." } })).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SpecialistSchemaError);
    expect(error).toMatchObject({ specialist: "reviewer", phase: "output", path: "notes.0" });
    expect(String(error)).toContain("reviewer output invalid at notes.0: Invalid input: expected string, received number");
  });

  it("rejects input before the model is called", async () => {
    let calls = 0;
    const handlers = createStepHandlers({
      async complete() {
        calls += 1;
        return "{}";
      },
    });
    const error = await handlers.implement(context("implement", {})).catch((caught: unknown) => caught);

    expect(calls).toBe(0);
    expect(error).toMatchObject({ specialist: "implementer", phase: "input", path: "planSummary" });
  });
});

function context(step: StepId, outputs: Partial<Record<StepId, Json>>): StepContext {
  return {
    runId: "run-1",
    issue: "Fix the stub.",
    step: { id: step, retries: 0 },
    outputs,
    feedback: null,
    attempt: 1,
    loop: 0,
  };
}
