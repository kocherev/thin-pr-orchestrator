export const packageId = "@thin-pr/gate" as const;

export type GateReadiness = "unconfigured";

export function readiness(): GateReadiness {
  return "unconfigured";
}
