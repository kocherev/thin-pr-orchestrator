import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  evalReportSchema,
  expectedSchema,
  runRecordSchema,
  type EvalReport,
  type Expected,
  type RunRecord,
} from "./schema";
import { runStartedAt } from "./run";

function parseJsonFile<T>(schema: z.ZodType<T>, file: string): T {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new Error(`${file} does not match the schema:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function readRuns(directory: string): RunRecord[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => parseJsonFile(runRecordSchema, join(directory, name)));
}

/** Reads every RunRecord in the directories, newest first. */
export function loadRuns(directories: string[]): RunRecord[] {
  const runs = directories.flatMap(readRuns);
  const seen = new Set<string>();
  for (const run of runs) {
    if (seen.has(run.runId)) throw new Error(`Duplicate runId "${run.runId}" in ${directories.join(", ")}`);
    seen.add(run.runId);
  }
  return runs.sort((a, b) => (runStartedAt(b) ?? "").localeCompare(runStartedAt(a) ?? ""));
}

export function loadEvalReport(file: string): EvalReport | null {
  return existsSync(file) ? parseJsonFile(evalReportSchema, file) : null;
}

/** Reads the expected label of every case under `evals/cases/`, keyed by case id. */
export function loadExpected(casesDirectory: string): Map<string, Expected> {
  if (!existsSync(casesDirectory)) return new Map();
  return new Map(
    readdirSync(casesDirectory)
      .filter((id) => existsSync(join(casesDirectory, id, "expected.json")))
      .map((id) => [id, parseJsonFile(expectedSchema, join(casesDirectory, id, "expected.json"))]),
  );
}
