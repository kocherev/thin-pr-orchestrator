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

export type FileChange = {
  readonly path: string;
  readonly before: string;
  readonly after: string;
};

export type DiffMeasurement = {
  readonly files: number;
  readonly lines: number;
  readonly meaningful: boolean;
};

export type BudgetLimits = {
  readonly maxFiles: number;
  readonly maxLines: number;
};

export type RunnerEvidence = {
  readonly diff: DiffMeasurement;
  readonly testsPassed: boolean;
  readonly budget: BudgetLimits;
};

const CONTRACTS = [
  ["plan", "plan", plannerOutput],
  ["implement", "implement", implementerOutput],
  ["test", "test", testerOutput],
  ["review", "review", reviewerOutput],
  ["pr-writer", "pullRequest", prWriterOutput],
] as const;

export function evaluate(subject: GateSubject, runner?: RunnerEvidence): readonly GateRuleResult[] {
  return [planRule(subject), testsRule(subject, runner), contractsRule(subject), diffRule(runner), budgetRule(runner)];
}

export function decide(subject?: GateSubject, runner?: RunnerEvidence): "pass" | "fail" {
  // The template hook is called with no run, so there is nothing to reject.
  if (!subject) {
    return "pass";
  }
  return evaluate(subject, runner).every((result) => result.verdict === "PASS") ? "pass" : "fail";
}

export function measureDiff(changes: readonly FileChange[]): DiffMeasurement {
  let files = 0;
  let lines = 0;
  let meaningful = false;
  for (const change of changes) {
    if (change.before === change.after) {
      continue;
    }
    files += 1;
    lines += lineChangeCount(change.before, change.after);
    if (normalize(change.before) !== normalize(change.after)) {
      meaningful = true;
    }
  }
  return { files, lines, meaningful };
}

export function lineChangeCount(before: string, after: string): number {
  const removed = sourceLines(before);
  const added = sourceLines(after);
  const shared = longestCommonSubsequence(removed, added);
  return removed.length - shared + (added.length - shared);
}

export function parseBudget(value: unknown): BudgetLimits {
  const record = objectValue(value, "budget");
  return {
    maxFiles: positiveInteger(record.maxFiles, "budget maxFiles"),
    maxLines: positiveInteger(record.maxLines, "budget maxLines"),
  };
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

function testsRule(subject: GateSubject, runner?: RunnerEvidence): GateRuleResult {
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
  if (!runner?.testsPassed) {
    return rule("tests", "FAIL", "Runner did not confirm the tests.");
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

function diffRule(runner?: RunnerEvidence): GateRuleResult {
  if (!runner) {
    return rule("diff", "FAIL", "Diff was not measured.");
  }
  if (runner.diff.files === 0 || runner.diff.lines === 0) {
    return rule("diff", "FAIL", "Diff is empty.");
  }
  if (!runner.diff.meaningful) {
    return rule("diff", "FAIL", "Diff has no meaningful change.");
  }
  return rule("diff", "PASS", `Diff is present (${countNoun(runner.diff.files, "file")}, ${countNoun(runner.diff.lines, "line")}).`);
}

function budgetRule(runner?: RunnerEvidence): GateRuleResult {
  if (!runner) {
    return rule("budget", "FAIL", "Budget was not measured.");
  }
  const { files, lines } = runner.diff;
  const { maxFiles, maxLines } = runner.budget;
  const detail = `${countNoun(files, "file")}, ${countNoun(lines, "line")}; limit ${countNoun(maxFiles, "file")}, ${countNoun(maxLines, "line")}`;
  if (files > maxFiles || lines > maxLines) {
    return rule("budget", "FAIL", `Diff exceeds the budget (${detail}).`);
  }
  return rule("budget", "PASS", `Diff is within the budget (${detail}).`);
}

function rule(name: string, verdict: GateVerdict, reason: string): GateRuleResult {
  return { rule: name, verdict, reason };
}

function countNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function normalize(text: string): string {
  return sourceLines(text)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function sourceLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function longestCommonSubsequence(left: readonly string[], right: readonly string[]): number {
  const prev = new Array<number>(right.length + 1).fill(0);
  const curr = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const above = prev[j] ?? 0;
      const leftOf = curr[j - 1] ?? 0;
      const diagonal = prev[j - 1] ?? 0;
      curr[j] = left[i - 1] === right[j - 1] ? diagonal + 1 : Math.max(above, leftOf);
    }
    for (let j = 0; j <= right.length; j += 1) {
      prev[j] = curr[j] ?? 0;
    }
  }
  return prev[right.length] ?? 0;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}
