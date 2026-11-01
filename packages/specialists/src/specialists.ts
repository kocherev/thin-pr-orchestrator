import { z } from "zod";
import {
  createStepContext,
  type ModelClient,
  type Specialist,
  type SpecialistName,
  type StepContext,
} from "./contract.js";

const text = z.string().min(1);

export const plannerInput = z.object({ issue: text, templateId: text }).strict();
export const plannerOutput = z
  .object({ summary: text, steps: z.array(text).min(1) })
  .strict();

const fileEdit = z.object({ path: text, content: z.string() }).strict();

export const implementerInput = z.object({ issue: text, planSummary: text }).strict();
export const implementerOutput = z
  .object({
    summary: text,
    files: z.array(text).min(1),
    edits: z.array(fileEdit).min(1).optional(),
  })
  .strict();

export const testerInput = z.object({ issue: text, changeSummary: text }).strict();
export const testerOutput = z.object({ summary: text, passed: z.boolean() }).strict();

export const reviewerInput = z.object({ issue: text, testSummary: text }).strict();
export const reviewerOutput = z
  .object({ summary: text, notes: z.array(z.string()) })
  .strict();

export const prWriterInput = z.object({ issue: text, reviewSummary: text }).strict();
export const prWriterOutput = z
  .object({ summary: text, title: text, body: text })
  .strict();

export const FIXTURES = {
  planner: { summary: "Plan the stub change.", steps: ["edit the stub"] },
  implementer: { summary: "Apply the stub change.", files: ["src/stub.ts"] },
  tester: { summary: "Stub checks passed.", passed: true },
  reviewer: { summary: "Stub review found nothing.", notes: [] },
  "pr-writer": { summary: "pass", title: "Fix the stub", body: "Stub draft." },
} as const;

export const planner = defineSpecialist("planner", plannerInput, plannerOutput);
export const implementer = defineSpecialist("implementer", implementerInput, implementerOutput);
export const tester = defineSpecialist("tester", testerInput, testerOutput);
export const reviewer = defineSpecialist("reviewer", reviewerInput, reviewerOutput);
export const prWriter = defineSpecialist("pr-writer", prWriterInput, prWriterOutput);

export const specialists = [planner, implementer, tester, reviewer, prWriter] as const;

export class ReplayModelClient implements ModelClient {
  constructor(private readonly overrides: Partial<Record<SpecialistName, string>> = {}) {}

  async complete(request: {
    readonly specialist: SpecialistName;
    readonly prompt: string;
  }): Promise<string> {
    return this.overrides[request.specialist] ?? JSON.stringify(FIXTURES[request.specialist]);
  }
}

function defineSpecialist<I, O>(
  name: SpecialistName,
  input: z.ZodType<I>,
  output: z.ZodType<O>,
): Specialist<I, O> {
  return {
    name,
    input,
    output,
    async run(ctx, value) {
      assertContext(name, ctx);
      ctx.log({ specialist: name, kind: "start" });
      const text = await ctx.model.complete({
        specialist: name,
        prompt: JSON.stringify({
          workdir: ctx.workdir,
          maxTokens: ctx.budget.maxTokens,
          maxSeconds: ctx.budget.maxSeconds,
          input: value,
        }),
      });
      ctx.log({ specialist: name, kind: "finish" });
      return readJson(name, text) as O;
    },
  };
}

function assertContext(name: SpecialistName, ctx: StepContext): void {
  if (ctx.workdir.length === 0) {
    throw new Error(`${name} workdir is empty`);
  }
  if (ctx.budget.maxTokens <= 0 || ctx.budget.maxSeconds <= 0) {
    throw new Error(`${name} budget is empty`);
  }
}

function readJson(name: SpecialistName, text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${name} model text is not JSON`);
  }
}

export function fixtureContext(model: ModelClient = new ReplayModelClient()): StepContext {
  return createStepContext(model);
}
