export { openEventLog, type EventLog, type NewLogEvent } from "./log.js";
export { replay, runWorkflow, type RunInput } from "./machine.js";
export { loadTemplate, parseTemplate } from "./template.js";
export {
  isPhase,
  isStepName,
  STEP_NAMES,
  type LogEvent,
  type Phase,
  type RunState,
  type Specialist,
  type SpecialistInput,
  type SpecialistMap,
  type SpecialistOutput,
  type StepName,
  type WorkflowTemplate,
} from "./types.js";

export const packageId = "@thin-pr/core" as const;

export function ping(): "pong" {
  return "pong";
}
