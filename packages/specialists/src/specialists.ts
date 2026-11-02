import type { Json, StepContext, StepHandler, StepId } from "@thin-pr/core";
import { z } from "zod";
import { SpecialistSchemaError, type ModelClient, type SpecialistName } from "./contract.js";

const text = z.string().min(1);

export const plannerOutput = z.object({ summary: text, steps: z.array(text).min(1) }).strict();

export const implementerOutput = z
  .object({
    summary: text,
    files: z.array(text).min(1),
    edits: z.array(z.object({ path: text, content: z.string() }).strict()).min(1).optional(),
  })
  .strict();

export const testerOutput = z.object({ summary: text, passed: z.boolean() }).strict();

/** The verify step's output: the recorded tester verdict plus the runner's parse of the changed sources. */
export const verifyOutput = testerOutput.extend({ sourcesParse: z.boolean() }).strict();

export const reviewerOutput = z.object({ summary: text, notes: z.array(z.string()) }).strict();

export const prWriterOutput = z.object({ summary: text, title: text, body: text }).strict();

type StepSpec = {
  readonly specialist: SpecialistName;
  readonly input: z.ZodType;
  readonly output: z.ZodType<Json>;
  readonly read: (context: StepContext) => unknown;
};

const STEPS: Record<StepId, StepSpec> = {
  plan: {
    specialist: "planner",
    input: z.object({ issue: text }).strict(),
    output: plannerOutput,
    read: (context) => ({ issue: context.issue }),
  },
  implement: {
    specialist: "implementer",
    input: z.object({ issue: text, planSummary: text }).strict(),
    output: implementerOutput,
    read: (context) => ({ issue: context.issue, planSummary: summaryOf(context.outputs.plan) }),
  },
  verify: {
    specialist: "tester",
    input: z.object({ issue: text, changeSummary: text }).strict(),
    output: testerOutput,
    read: (context) => ({ issue: context.issue, changeSummary: summaryOf(context.outputs.implement) }),
  },
  review: {
    specialist: "reviewer",
    input: z.object({ issue: text, testSummary: text }).strict(),
    output: reviewerOutput,
    read: (context) => ({ issue: context.issue, testSummary: summaryOf(context.outputs.verify) }),
  },
  write: {
    specialist: "pr-writer",
    input: z.object({ issue: text, reviewSummary: text }).strict(),
    output: prWriterOutput,
    read: (context) => ({ issue: context.issue, reviewSummary: summaryOf(context.outputs.review) }),
  },
};

const FIXTURES: Record<SpecialistName, Json> = {
  planner: { summary: "Plan the stub change.", steps: ["edit the stub"] },
  implementer: { summary: "Apply the stub change.", files: ["src/stub.ts"] },
  tester: { summary: "Stub checks passed.", passed: true },
  reviewer: { summary: "Stub review found nothing.", notes: [] },
  "pr-writer": { summary: "pass", title: "Fix the stub", body: "Stub draft." },
};

/** One handler per step. Each one validates its input, asks the model, and validates the reply. */
export function createStepHandlers(model: ModelClient): Record<StepId, StepHandler> {
  return {
    plan: handler(STEPS.plan, model),
    implement: handler(STEPS.implement, model),
    verify: handler(STEPS.verify, model),
    review: handler(STEPS.review, model),
    write: handler(STEPS.write, model),
  };
}

export class ReplayModelClient implements ModelClient {
  constructor(private readonly overrides: Partial<Record<SpecialistName, string>> = {}) {}

  async complete(request: { readonly specialist: SpecialistName; readonly prompt: string }): Promise<string> {
    return this.overrides[request.specialist] ?? JSON.stringify(FIXTURES[request.specialist]);
  }
}

/** The `summary` field every step output carries, or "" when it is missing. */
export function summaryOf(output: Json | undefined): string {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return "";
  }
  return typeof output.summary === "string" ? output.summary : "";
}

function handler(spec: StepSpec, model: ModelClient): StepHandler {
  return async (context) => {
    const input = parse(spec.specialist, "input", spec.input, spec.read(context));
    const text = await model.complete({
      specialist: spec.specialist,
      prompt: JSON.stringify({ input, feedback: context.feedback }),
    });
    const output = parse(spec.specialist, "output", spec.output, readJson(spec.specialist, text));
    return { outcome: "done", output };
  };
}

function parse<T>(specialist: SpecialistName, phase: "input" | "output", schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  throw new SpecialistSchemaError(specialist, phase, issue?.path.join(".") || "(root)", issue?.message ?? "invalid");
}

function readJson(specialist: SpecialistName, text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  try {
    return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
  } catch {
    throw new Error(`${specialist} model text is not JSON`);
  }
}
