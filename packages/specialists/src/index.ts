import { SPECIALIST_NAMES, type SpecialistName } from "./contract.js";

export const packageId = "@thin-pr/specialists" as const;

export type SpecialistDescriptor = {
  readonly id: SpecialistName;
};

export function listSpecialists(): readonly SpecialistDescriptor[] {
  return SPECIALIST_NAMES.map((id) => ({ id }));
}

export { createStubSpecialists, type StubInput, type StubOutput, type StubSpecialist, type StubStep, STUB_STEPS } from "./adapter.js";
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
  planner,
  prWriter,
  ReplayModelClient,
  reviewer,
  specialists,
  tester,
} from "./specialists.js";
