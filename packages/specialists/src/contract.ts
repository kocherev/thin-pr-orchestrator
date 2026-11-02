export type SpecialistName = "planner" | "implementer" | "reviewer" | "pr-writer";

export interface ModelClient {
  complete(request: {
    readonly specialist: SpecialistName;
    readonly prompt: string;
  }): Promise<string>;
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
