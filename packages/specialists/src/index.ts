import { SPECIALIST_NAMES, type SpecialistName } from "./contract.js";

export const packageId = "@thin-pr/specialists" as const;

export type SpecialistDescriptor = {
  readonly id: SpecialistName;
};

export function listSpecialists(): readonly SpecialistDescriptor[] {
  return SPECIALIST_NAMES.map((id) => ({ id }));
}

export {
  createRunCapture,
  createStubSpecialists,
  type CapturedRun,
  type StubInput,
  type StubOutput,
  type StubSpecialist,
  type StubStep,
  STUB_STEPS,
} from "./adapter.js";
export {
  createStepContext,
  executeSpecialist,
  SPECIALIST_NAMES,
  SpecialistSchemaError,
  type Budget,
  type ModelClient,
  type RunEvent,
  type Specialist,
  type SpecialistName,
  type StepContext,
} from "./contract.js";
export {
  FIXTURES,
  implementer,
  implementerOutput,
  planner,
  plannerOutput,
  prWriter,
  prWriterOutput,
  ReplayModelClient,
  reviewer,
  reviewerOutput,
  specialists,
  tester,
  testerOutput,
} from "./specialists.js";
