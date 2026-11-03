import type { GateRuleResult, RunStatus, RunStep } from "./schema";

/** Plain words for the values the RunRecord stores as identifiers. */
export const STATUS_LABEL: Record<RunStatus, string> = {
  opened: "Opened",
  awaiting_approval: "Needs approval",
  blocked: "Blocked",
  failed: "Failed",
};

export const VERDICT_LABEL: Record<GateRuleResult["verdict"], string> = {
  PASS: "Passed",
  FAIL: "Failed",
  NEEDS_APPROVAL: "Needs approval",
};

export const RULE_LABEL: Record<GateRuleResult["rule"], string> = {
  plan: "Plan",
  contracts: "Step contracts",
  diff: "Diff check",
  budget: "Size budget",
  paths: "Path check",
  secrets: "Secret scan",
  typecheck: "Typecheck",
  tests: "Tests",
  review: "Code review",
};

export const STEP_LABEL: Record<RunStep["id"], string> = {
  plan: "Plan",
  implement: "Implement",
  verify: "Verify",
  review: "Review",
  write: "Write",
};

/** The eval report stores failed rules as plain strings, so an unknown one shows as stored. */
export function ruleLabel(rule: string): string {
  return Object.hasOwn(RULE_LABEL, rule) ? RULE_LABEL[rule as GateRuleResult["rule"]] : rule;
}

const list = new Intl.ListFormat("en", { type: "conjunction" });

export function joinWords(words: readonly string[]): string {
  return list.format(words);
}
