import type { StepId } from "@thin-pr/core";
import {
  implementerOutput,
  plannerOutput,
  prWriterOutput,
  reviewerOutput,
  verifyOutput,
} from "@thin-pr/specialists";

export type GateVerdict = "PASS" | "FAIL";

export type GateRuleResult = {
  readonly rule: string;
  readonly verdict: GateVerdict;
  readonly reason: string;
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

export type RunEvidence = {
  /** Step outputs as the run log stores them. */
  readonly outputs: Readonly<Partial<Record<StepId, unknown>>>;
  /** The runner's measurement of the file bytes it would commit, or null when nothing was measured. */
  readonly diff: DiffMeasurement | null;
  readonly budget: BudgetLimits;
};

const CONTRACTS = [
  ["plan", plannerOutput],
  ["implement", implementerOutput],
  ["verify", verifyOutput],
  ["review", reviewerOutput],
  ["write", prWriterOutput],
] as const;

export function evaluate(evidence: RunEvidence): readonly GateRuleResult[] {
  return [planRule(evidence), testsRule(evidence), contractsRule(evidence), diffRule(evidence), budgetRule(evidence)];
}

export function decide(evidence: RunEvidence): "pass" | "fail" {
  return evaluate(evidence).every((result) => result.verdict === "PASS") ? "pass" : "fail";
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

function planRule({ outputs }: RunEvidence): GateRuleResult {
  if (outputs.plan === null || outputs.plan === undefined) {
    return rule("plan", "FAIL", "Plan is missing.");
  }
  const parsed = plannerOutput.safeParse(outputs.plan);
  if (!parsed.success) {
    return rule("plan", "FAIL", "Plan output does not match its contract.");
  }
  return rule("plan", "PASS", `Plan is present (${countNoun(parsed.data.steps.length, "step")}).`);
}

function testsRule({ outputs, diff }: RunEvidence): GateRuleResult {
  if (outputs.verify === null || outputs.verify === undefined) {
    return rule("tests", "FAIL", "Test result is missing.");
  }
  const parsed = verifyOutput.safeParse(outputs.verify);
  if (!parsed.success) {
    return rule("tests", "FAIL", "Test output does not match its contract.");
  }
  if (!parsed.data.passed) {
    return rule("tests", "FAIL", "Tests did not pass.");
  }
  if (!diff?.meaningful || !parsed.data.sourcesParse) {
    return rule("tests", "FAIL", "Runner did not confirm the tests.");
  }
  return rule("tests", "PASS", "Tests passed.");
}

function contractsRule({ outputs }: RunEvidence): GateRuleResult {
  for (const [step, schema] of CONTRACTS) {
    const value = outputs[step];
    if (value === null || value === undefined) {
      return rule("contracts", "FAIL", `Missing ${step} output.`);
    }
    if (!schema.safeParse(value).success) {
      return rule("contracts", "FAIL", `${step} output does not match its contract.`);
    }
  }
  return rule("contracts", "PASS", "Specialist outputs match their contracts.");
}

function diffRule({ diff }: RunEvidence): GateRuleResult {
  if (!diff) {
    return rule("diff", "FAIL", "Diff was not measured.");
  }
  if (diff.files === 0 || diff.lines === 0) {
    return rule("diff", "FAIL", "Diff is empty.");
  }
  if (!diff.meaningful) {
    return rule("diff", "FAIL", "Diff has no meaningful change.");
  }
  return rule("diff", "PASS", `Diff is present (${countNoun(diff.files, "file")}, ${countNoun(diff.lines, "line")}).`);
}

function budgetRule({ diff, budget }: RunEvidence): GateRuleResult {
  if (!diff) {
    return rule("budget", "FAIL", "Budget was not measured.");
  }
  const { files, lines } = diff;
  const { maxFiles, maxLines } = budget;
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
