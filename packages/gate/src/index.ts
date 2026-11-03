import { plannerOutput, reviewerOutput, type CheckResult, type Diff } from "@thin-pr/specialists";
import { classifyPath, type RepoConfig } from "@thin-pr/workspace";
import { scanAddedLines } from "./secrets.js";

export const GATE_RULES = ["plan", "contracts", "diff", "budget", "paths", "secrets", "typecheck", "tests", "review"] as const;

type GateRule = (typeof GATE_RULES)[number];

/** Only `budget` returns `NEEDS_APPROVAL`: the diff is over size and every other rule passes. */
export const GATE_VERDICTS = ["PASS", "FAIL", "NEEDS_APPROVAL"] as const;

export type GateRuleResult = {
  readonly rule: GateRule;
  readonly verdict: (typeof GATE_VERDICTS)[number];
  readonly reason: string;
};

/** `pass` opens a draft, `needs_approval` pushes the branch and waits for a person, `fail` pushes nothing. */
export type GateDecision = "pass" | "needs_approval" | "fail";

/** What the gate reads after a run. Step outputs stay `unknown` until a rule parses them. */
export type RunEvidence = {
  readonly plan: unknown;
  readonly review: unknown;
  /** Whether each step output matched its schema, as the orchestrator checked it. */
  readonly contracts: readonly { readonly step: string; readonly valid: boolean }[];
  /** The workspace diff against the base, or null when it was not measured. */
  readonly diff: Diff | null;
  readonly checks: readonly CheckResult[];
  /** The template's budget with the `.thin-pr.yml` overrides applied. */
  readonly budget: { readonly max_files: number; readonly max_lines: number };
  readonly config: RepoConfig;
};

const RULES: Record<GateRule, (evidence: RunEvidence) => GateRuleResult> = {
  plan: planRule,
  contracts: contractsRule,
  diff: diffRule,
  budget: budgetRule,
  paths: pathsRule,
  secrets: secretsRule,
  typecheck: (evidence) => checkRule("typecheck", evidence),
  tests: (evidence) => checkRule("tests", evidence),
  review: reviewRule,
};

/** One result per rule, in `GATE_RULES` order. */
export function evaluate(evidence: RunEvidence): readonly GateRuleResult[] {
  const results = GATE_RULES.map((rule) => RULES[rule](evidence));
  // An approval only answers the size. When another rule fails there is nothing to approve, so over size is a FAIL.
  const othersPass = results.every((result) => result.rule === "budget" || result.verdict === "PASS");
  return results.map((result) => (result.verdict === "NEEDS_APPROVAL" && !othersPass ? { ...result, verdict: "FAIL" } : result));
}

export function decide(evidence: RunEvidence): GateDecision {
  return decideResults(evaluate(evidence));
}

/** The decision over results `evaluate` returned, such as the ones a RunRecord stores. */
export function decideResults(results: readonly GateRuleResult[]): GateDecision {
  if (results.length === 0 || results.some((result) => result.verdict === "FAIL")) {
    return "fail";
  }
  return results.some((result) => result.verdict === "NEEDS_APPROVAL") ? "needs_approval" : "pass";
}

function planRule({ plan }: RunEvidence): GateRuleResult {
  if (plan === null || plan === undefined) {
    return fail("plan", "Plan is missing.");
  }
  const parsed = plannerOutput.safeParse(plan);
  if (!parsed.success) {
    return fail("plan", "Plan output does not match its contract.");
  }
  return pass("plan", `Plan is present (${countNoun(parsed.data.steps.length, "step")}).`);
}

function contractsRule({ contracts }: RunEvidence): GateRuleResult {
  if (contracts.length === 0) {
    return fail("contracts", "No step output was checked.");
  }
  const invalid = contracts.find((contract) => !contract.valid);
  if (invalid) {
    return fail("contracts", `${invalid.step} output does not match its contract.`);
  }
  return pass("contracts", "Step outputs match their contracts.");
}

function diffRule({ diff }: RunEvidence): GateRuleResult {
  if (!diff) {
    return fail("diff", "Diff was not measured.");
  }
  if (diff.files.length === 0) {
    return fail("diff", "Diff is empty.");
  }
  if (!diff.meaningful) {
    return fail("diff", "Diff only changes whitespace.");
  }
  return pass("diff", `Diff is present (${countNoun(diff.files.length, "file")}, ${countNoun(changedLines(diff), "line")}).`);
}

function budgetRule({ diff, budget }: RunEvidence): GateRuleResult {
  if (!diff) {
    return fail("budget", "Budget was not measured.");
  }
  const files = diff.files.length;
  const lines = changedLines(diff);
  const { max_files: maxFiles, max_lines: maxLines } = budget;
  const detail = `${countNoun(files, "file")}, ${countNoun(lines, "line")}; limit ${countNoun(maxFiles, "file")}, ${countNoun(maxLines, "line")}`;
  if (files > maxFiles || lines > maxLines) {
    // `evaluate` turns this into FAIL when another rule fails.
    return { rule: "budget", verdict: "NEEDS_APPROVAL", reason: `Diff exceeds the budget (${detail}).` };
  }
  return pass("budget", `Diff is within the budget (${detail}).`);
}

function pathsRule({ diff, config }: RunEvidence): GateRuleResult {
  if (!diff) {
    return fail("paths", "Paths were not measured.");
  }
  const blocked = diff.files.flatMap(({ path }) => {
    const verdict = classifyPath(config.paths, path);
    return verdict === "allowed" ? [] : [`${path} (${verdict === "denied" ? "denied" : "not in allow"})`];
  });
  if (blocked.length > 0) {
    return fail("paths", `Changed paths are not allowed: ${blocked.join(", ")}.`);
  }
  return pass("paths", "Every changed path is allowed.");
}

function secretsRule({ diff }: RunEvidence): GateRuleResult {
  if (!diff) {
    return fail("secrets", "Diff was not scanned.");
  }
  const findings = scanAddedLines(diff.patch);
  if (findings.length > 0) {
    const where = findings.map((finding) => `${finding.path}:${finding.line} (${finding.kind})`);
    return fail("secrets", `Added lines look like secrets: ${where.join(", ")}.`);
  }
  return pass("secrets", "No added line looks like a secret.");
}

function checkRule(rule: "typecheck" | "tests", { checks }: RunEvidence): GateRuleResult {
  const name = rule === "tests" ? "test" : "typecheck";
  const label = rule === "tests" ? "Tests" : "Typecheck";
  const check = checks.find((result) => result.name === name);
  if (!check) {
    return fail(rule, `${label} did not run.`);
  }
  if (check.exitCode !== 0) {
    return fail(rule, `${label} failed (exit ${check.exitCode}): ${check.command}`);
  }
  return pass(rule, `${label} passed: ${check.command}`);
}

function reviewRule({ review }: RunEvidence): GateRuleResult {
  if (review === null || review === undefined) {
    return fail("review", "Review is missing.");
  }
  const parsed = reviewerOutput.safeParse(review);
  if (!parsed.success) {
    return fail("review", "Review output does not match its contract.");
  }
  return parsed.data.verdict === "approve"
    ? pass("review", "Reviewer approved.")
    : fail("review", `Reviewer requested changes (${countNoun(parsed.data.notes.length, "note")}).`);
}

function changedLines(diff: Diff): number {
  return diff.files.reduce((sum, file) => sum + file.added + file.removed, 0);
}

function pass(rule: GateRule, reason: string): GateRuleResult {
  return { rule, verdict: "PASS", reason };
}

function fail(rule: GateRule, reason: string): GateRuleResult {
  return { rule, verdict: "FAIL", reason };
}

function countNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
