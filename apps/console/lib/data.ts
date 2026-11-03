import { join } from "node:path";
import { loadEvalReport, loadRuns } from "./load";
import type { EvalReport, RunRecord } from "./schema";

const consoleRoot = process.cwd();
const repoRoot = join(consoleRoot, "..", "..");

/** Eval replays come from `evals/`, real GitHub runs from `apps/console/data/runs/`. */
const RUN_DIRECTORIES = [join(repoRoot, "evals", "runs"), join(consoleRoot, "data", "runs")];
const REPORT_FILE = join(repoRoot, "evals", "report.json");

let runs: RunRecord[] | undefined;

export function getRuns(): RunRecord[] {
  runs ??= loadRuns(RUN_DIRECTORIES);
  return runs;
}

export function getRun(runId: string): RunRecord | undefined {
  return getRuns().find((run) => run.runId === runId);
}

export function getEvalReport(): EvalReport | null {
  return loadEvalReport(REPORT_FILE);
}
