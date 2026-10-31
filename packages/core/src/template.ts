import { readFileSync } from "node:fs";
import { isStepName, type StepName, type WorkflowTemplate } from "./types.js";

export function parseTemplate(value: unknown): WorkflowTemplate {
  if (!isRecord(value)) {
    throw new Error("template must be an object");
  }
  const { id, steps } = value;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("template id must be a non-empty string");
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("template steps must be a non-empty list");
  }

  const parsed: StepName[] = [];
  for (const step of steps) {
    if (typeof step !== "string" || !isStepName(step)) {
      throw new Error(`unknown template step: ${String(step)}`);
    }
    if (parsed.includes(step)) {
      throw new Error(`duplicate template step: ${step}`);
    }
    parsed.push(step);
  }
  return { id, steps: parsed };
}

export function loadTemplate(path: string): WorkflowTemplate {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parseTemplate(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
