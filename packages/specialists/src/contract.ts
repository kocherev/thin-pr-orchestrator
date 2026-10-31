import type { ZodType } from "zod";

export const SPECIALIST_NAMES = [
  "planner",
  "implementer",
  "tester",
  "reviewer",
  "pr-writer",
] as const;

export type SpecialistName = (typeof SPECIALIST_NAMES)[number];

export type Budget = {
  readonly maxTokens: number;
  readonly maxSeconds: number;
};

export type RunEvent = {
  readonly specialist: SpecialistName;
  readonly kind: "start" | "finish";
};

export interface ModelClient {
  complete(request: {
    readonly specialist: SpecialistName;
    readonly prompt: string;
  }): Promise<string>;
}

export interface StepContext {
  readonly workdir: string;
  readonly model: ModelClient;
  readonly budget: Budget;
  readonly log: (event: RunEvent) => void;
}

export interface Specialist<I, O> {
  readonly name: SpecialistName;
  readonly input: ZodType<I>;
  readonly output: ZodType<O>;
  run(ctx: StepContext, input: I): Promise<O>;
}

export class SpecialistSchemaError extends Error {
  readonly specialist: string;
  readonly phase: "input" | "output";
  readonly path: string;

  constructor(specialist: string, phase: "input" | "output", path: string, detail: string) {
    super(`${specialist} ${phase} invalid at ${path}: ${detail}`);
    this.name = "SpecialistSchemaError";
    this.specialist = specialist;
    this.phase = phase;
    this.path = path;
  }
}

export function createStepContext(model: ModelClient, workdir = "."): StepContext {
  return {
    workdir,
    model,
    budget: { maxTokens: 2000, maxSeconds: 30 },
    log() {
      return undefined;
    },
  };
}

export async function executeSpecialist<I, O>(
  specialist: Specialist<I, O>,
  ctx: StepContext,
  rawInput: unknown,
): Promise<O> {
  const input = readSchema(specialist.name, "input", specialist.input, rawInput);
  const rawOutput = await specialist.run(ctx, input);
  return readSchema(specialist.name, "output", specialist.output, rawOutput);
}

function readSchema<T>(
  specialist: string,
  phase: "input" | "output",
  schema: ZodType<T>,
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".") || "(root)";
  const detail = issue?.message ?? "invalid";
  throw new SpecialistSchemaError(specialist, phase, path, detail);
}
