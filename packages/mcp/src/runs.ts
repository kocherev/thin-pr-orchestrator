import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// The RunRecord fields the tools read. Loose, so get_run returns every other field as it was written.
const storedRun = z.looseObject({
  version: z.literal(1),
  runId: z.string().min(1),
  issue: z.looseObject({ title: z.string() }),
  status: z.enum(["opened", "awaiting_approval", "blocked", "failed"]),
  gate: z.array(z.looseObject({ rule: z.string(), verdict: z.enum(["PASS", "FAIL", "NEEDS_APPROVAL"]) })),
  totals: z.looseObject({ costUsd: z.number() }),
});

type StoredRun = z.infer<typeof storedRun>;

/** One line per RunRecord in `dir`, newest file first. Files that are not RunRecords are named in `skipped`. */
export function listRuns(dir: string) {
  const { runs, skipped } = readRuns(dir);
  return {
    runs: runs.map((run) => ({
      runId: run.runId,
      issue: run.issue.title,
      status: run.status,
      gate: gateSummary(run.gate),
      costUsd: run.totals.costUsd,
    })),
    skipped,
  };
}

export function findRun(dir: string, runId: string): StoredRun {
  const run = readRuns(dir).runs.find((item) => item.runId === runId);
  if (!run) {
    throw new Error(`no RunRecord with runId ${runId} in ${dir}`);
  }
  return run;
}

function readRuns(dir: string): { runs: StoredRun[]; skipped: string[] } {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, path: join(dir, name) }))
    .sort((left, right) => statSync(right.path).mtimeMs - statSync(left.path).mtimeMs);
  const runs: StoredRun[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const parsed = storedRun.safeParse(parseJson(readFileSync(file.path, "utf8")));
    if (parsed.success) {
      runs.push(parsed.data);
    } else {
      skipped.push(file.name);
    }
  }
  return { runs, skipped };
}

function gateSummary(gate: StoredRun["gate"]): string {
  if (gate.length === 0) {
    return "not evaluated";
  }
  const failed = gate.filter((rule) => rule.verdict === "FAIL").map((rule) => rule.rule);
  const waiting = gate.filter((rule) => rule.verdict === "NEEDS_APPROVAL").map((rule) => rule.rule);
  if (failed.length > 0) {
    return `failed: ${failed.join(", ")}`;
  }
  return waiting.length > 0 ? `needs approval: ${waiting.join(", ")}` : `passed ${gate.length}/${gate.length}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
