export const packageId = "@thin-pr/specialists" as const;

export type SpecialistDescriptor = {
  readonly id: string;
};

export function listSpecialists(): readonly SpecialistDescriptor[] {
  return [];
}
