import type { EvalCase, EvalReport, Expected } from "./schema";

function sameItems(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

/**
 * The rule `scripts/eval.ts` scores verdict accuracy with: a run that failed before the gate
 * counts as blocked, and a case labeled with failed rules must fail exactly those rules.
 */
export function isCorrect(evalCase: EvalCase, expected: Expected | undefined): boolean {
  const verdict = evalCase.actual === "failed" ? "blocked" : evalCase.actual;
  const rulesMatch = !expected?.failedRules || sameItems(expected.failedRules, evalCase.failedRules);
  return verdict === evalCase.expected && rulesMatch;
}

/** The same scores `pnpm eval` prints, from the committed report and case labels. */
export function summarizeEvals(report: EvalReport, expected: ReadonlyMap<string, Expected>) {
  const { cases } = report;
  const shouldOpen = cases.filter((evalCase) => evalCase.expected === "opened");
  const resolved = shouldOpen.filter((evalCase) => evalCase.actual === "opened").length;
  const shouldOpenCostUsd = shouldOpen.reduce((sum, evalCase) => sum + evalCase.costUsd, 0);
  return {
    total: cases.length,
    correct: cases.filter((evalCase) => isCorrect(evalCase, expected.get(evalCase.caseId))).length,
    shouldOpen: shouldOpen.length,
    resolved,
    totalCostUsd: cases.reduce((sum, evalCase) => sum + evalCase.costUsd, 0),
    costPerResolvedUsd: resolved > 0 ? shouldOpenCostUsd / resolved : null,
  };
}
