export const packageId = "@thin-pr/gate" as const;

export type GateReadiness = "unconfigured";

export function readiness(): GateReadiness {
  return "unconfigured";
}

export type GateDecision = "pass";

export function decide(): GateDecision {
  return "pass";
}
