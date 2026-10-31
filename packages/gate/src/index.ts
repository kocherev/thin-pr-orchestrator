import {
  implementerOutput,
  plannerOutput,
  prWriterOutput,
  reviewerOutput,
  testerOutput,
} from "@thin-pr/specialists";

export const packageId = "@thin-pr/gate" as const;

export type GateReadiness = "ready";

export function readiness(): GateReadiness {
  return "ready";
}

export type GateVerdict = "PASS" | "FAIL";

export type GateRuleResult = {
  readonly rule: string;
  readonly verdict: GateVerdict;
  readonly reason: string;
};

export type GateSubject = {
  readonly plan: unknown;
  readonly implement: unknown;
  readonly test: unknown;
  readonly review: unknown;
  readonly pullRequest: unknown;
};

const CONTRACTS = [
  ["plan", "plan", plannerOutput],
  ["implement", "implement", implementerOutput],
  ["test", "test", testerOutput],
  ["review", "review", reviewerOutput],
  ["pr-writer", "pullRequest", prWriterOutput],
] as const;

export function evaluate(subject: GateSubject): readonly GateRuleResult[] {
  return [planRule(subject), testsRule(subject), contractsRule(subject)];
}

export function decide(subject?: GateSubject): "pass" | "fail" {
  // The template hook is called with no run, so there is nothing to reject.
  if (!subject) {
    return "pass";
  }
  return evaluate(subject).every((result) => result.verdict === "PASS") ? "pass" : "fail";
}

function planRule(subject: GateSubject): GateRuleResult {
  if (subject.plan === null || subject.plan === undefined) {
    return rule("plan", "FAIL", "Plan is missing.");
  }
  const parsed = plannerOutput.safeParse(subject.plan);
  if (!parsed.success) {
    return rule("plan", "FAIL", "Plan output does not match its contract.");
  }
  const count = parsed.data.steps.length;
  const noun = count === 1 ? "step" : "steps";
  return rule("plan", "PASS", `Plan is present (${count} ${noun}).`);
}

function testsRule(subject: GateSubject): GateRuleResult {
  if (subject.test === null || subject.test === undefined) {
    return rule("tests", "FAIL", "Test result is missing.");
  }
  const parsed = testerOutput.safeParse(subject.test);
  if (!parsed.success) {
    return rule("tests", "FAIL", "Test output does not match its contract.");
  }
  if (!parsed.data.passed) {
    return rule("tests", "FAIL", "Tests did not pass.");
  }
  return rule("tests", "PASS", "Tests passed.");
}

function contractsRule(subject: GateSubject): GateRuleResult {
  for (const [label, key, schema] of CONTRACTS) {
    const value = subject[key];
    if (value === null || value === undefined) {
      return rule("contracts", "FAIL", `Missing ${label} output.`);
    }
    if (!schema.safeParse(value).success) {
      return rule("contracts", "FAIL", `${label} output does not match its contract.`);
    }
  }
  return rule("contracts", "PASS", "Specialist outputs match their contracts.");
}

function rule(name: string, verdict: GateVerdict, reason: string): GateRuleResult {
  return { rule: name, verdict, reason };
}
