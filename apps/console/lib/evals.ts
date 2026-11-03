import type { EvalReport } from "./schema";

/** The same scores `pnpm eval` prints, from the committed report. */
export function summarizeEvals(report: EvalReport) {
  const { cases } = report;
  const shouldOpen = cases.filter((evalCase) => evalCase.expected === "opened");
  const resolved = shouldOpen.filter((evalCase) => evalCase.actual === "opened").length;
  const shouldOpenCostUsd = shouldOpen.reduce((sum, evalCase) => sum + evalCase.costUsd, 0);
  return {
    total: cases.length,
    matched: cases.filter((evalCase) => evalCase.expected === evalCase.actual).length,
    shouldOpen: shouldOpen.length,
    resolved,
    totalCostUsd: cases.reduce((sum, evalCase) => sum + evalCase.costUsd, 0),
    costPerResolvedUsd: resolved > 0 ? shouldOpenCostUsd / resolved : null,
  };
}
