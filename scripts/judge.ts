import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JUDGE_CRITERIA,
  JUDGE_EFFORT,
  JUDGE_MODEL,
  judgeRequest,
  readJudgeResult,
  runJudgeBatch,
  spendLimitFrom,
  type JudgeCriterion,
  type JudgeResult,
  type JudgeSubject,
} from "@thin-pr/specialists";
import { z } from "zod";
import { isDirectRun, loadCases, runEval, scriptArgs, type CaseResult, type EvalCase } from "./eval.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const JUDGE_CASSETTE = "evals/judge-cassette.jsonl";

const passFail = z.enum(["pass", "fail"]);

/** `evals/cases/<id>/judge.json`: the human grade for each criterion, and why. */
const labelSchema = z
  .object({ plan_relevance: passFail, minimal_diff: passFail, test_adequacy: passFail, review_quality: passFail, note: z.string().min(1) })
  .strict();

export type Label = z.infer<typeof labelSchema>;

const baselineSchema = z.object({ minAgreement: z.number().gt(0).lte(1) }).strict();

/** One line of the judge cassette: a batch result and the hash of the request that produced it. */
const cassetteLine = z
  .object({
    source: z.literal("live"),
    caseId: z.string().min(1),
    recordedAt: z.iso.datetime(),
    requestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    result: z.json(),
  })
  .strict();

type CassetteLine = z.infer<typeof cassetteLine>;

export type JudgedCase = { readonly caseId: string; readonly label: Label; readonly result: JudgeResult };

export type JudgeReport =
  | { readonly recorded: false; readonly labels: ReadonlyMap<string, Label>; readonly minAgreement: number }
  | {
      readonly recorded: true;
      readonly cases: readonly JudgedCase[];
      readonly agreement: Agreement;
      readonly costUsd: number;
      readonly minAgreement: number;
      readonly meetsBaseline: boolean;
    };

type Count = { readonly matched: number; readonly total: number };

export type Agreement = Count & {
  readonly byCriterion: Readonly<Record<JudgeCriterion, Count>>;
  /** Grades labeled fail that the judge also failed. An always-pass judge catches none. */
  readonly failsCaught: Count;
};

export function loadLabels(workspace = root): Map<string, Label> {
  return new Map(
    loadCases(workspace).map((item) => {
      const path = join(workspace, "evals", "cases", item.id, "judge.json");
      if (!existsSync(path)) {
        throw new Error(`${item.id}: judge.json is missing`);
      }
      return [item.id, labelSchema.parse(JSON.parse(readFileSync(path, "utf8")))];
    }),
  );
}

/** What the judge reads from a replayed case: the issue, the plan and review outputs, the diff and the checks. */
export function subjectOf(item: EvalCase, run: CaseResult): JudgeSubject {
  return {
    caseId: run.id,
    issue: `${item.issueTitle}\n\n${item.issueBody}`,
    status: run.actual,
    error: run.error,
    plan: run.outputs.plan ?? null,
    patch: run.record.diff?.patch ?? "",
    checks: run.record.checks,
    review: run.outputs.review ?? null,
  };
}

/** A criterion counts as agreed when the judge graded it the way the label does. A case the judge could not grade agrees on nothing. */
export function agreement(cases: readonly JudgedCase[]): Agreement {
  const count = (criterion: JudgeCriterion): Count => ({
    matched: cases.filter((item) => item.result.outcome === "graded" && item.result.verdict[criterion].verdict === item.label[criterion])
      .length,
    total: cases.length,
  });
  const byCriterion = {
    plan_relevance: count("plan_relevance"),
    minimal_diff: count("minimal_diff"),
    test_adequacy: count("test_adequacy"),
    review_quality: count("review_quality"),
  };
  const counts = Object.values(byCriterion);
  const fails = cases.flatMap((item) => JUDGE_CRITERIA.filter((criterion) => item.label[criterion] === "fail").map((criterion) => ({ item, criterion })));
  return {
    matched: counts.reduce((sum, count) => sum + count.matched, 0),
    total: counts.reduce((sum, count) => sum + count.total, 0),
    byCriterion,
    failsCaught: {
      matched: fails.filter(({ item, criterion }) => item.result.outcome === "graded" && item.result.verdict[criterion].verdict === "fail").length,
      total: fails.length,
    },
  };
}

/** Sends one batch to the live API, writes the judge cassette, and returns each case's result. */
export async function recordJudge(
  subjects: readonly JudgeSubject[],
  options: { readonly cassettePath: string; readonly env: Record<string, string | undefined>; readonly pollMs: number; readonly fetch?: typeof fetch; readonly log?: (line: string) => void },
): Promise<Map<string, JudgeResult>> {
  const requests = subjects.map(judgeRequest);
  const results = await runJudgeBatch(requests, {
    apiKey: options.env.ANTHROPIC_API_KEY,
    spendLimitUsd: spendLimitFrom(options.env),
    pollMs: options.pollMs,
    fetch: options.fetch,
    onPoll: (batch) => options.log?.(`batch ${batch.id} ${batch.processing_status}, ${batch.request_counts.processing} processing`),
  });
  const byId = new Map(results.map((result) => [result.custom_id, result]));
  const recordedAt = new Date().toISOString();
  const lines: CassetteLine[] = requests.map((request) => {
    const result = byId.get(request.custom_id);
    if (!result) {
      throw new Error(`the batch has no result for ${request.custom_id}`);
    }
    return { source: "live", caseId: request.custom_id, recordedAt, requestSha256: requestHash(request), result: z.json().parse(result.result) };
  });
  mkdirSync(dirname(options.cassettePath), { recursive: true });
  writeFileSync(options.cassettePath, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  return new Map(lines.map((line) => [line.caseId, readJudgeResult(line.result)]));
}

/** Reads each case's recorded result. A request that changed since the recording makes the cassette stale. */
export function replayJudge(subjects: readonly JudgeSubject[], cassettePath: string): Map<string, JudgeResult> {
  const lines = new Map(
    readFileSync(cassettePath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const parsed = cassetteLine.parse(JSON.parse(line));
        return [parsed.caseId, parsed] as const;
      }),
  );
  return new Map(
    subjects.map((subject) => {
      const line = lines.get(subject.caseId);
      if (!line || line.requestSha256 !== requestHash(judgeRequest(subject))) {
        throw new Error(`${cassettePath} is stale for ${subject.caseId}. Run pnpm eval:judge -- --record to grade the runs again.`);
      }
      return [subject.caseId, readJudgeResult(line.result)];
    }),
  );
}

export function judgeReport(results: ReadonlyMap<string, JudgeResult>, labels: ReadonlyMap<string, Label>, minAgreement: number): JudgeReport {
  const cases = [...labels].map(([caseId, label]) => {
    const result = results.get(caseId);
    if (!result) {
      throw new Error(`${caseId}: the judge has no result`);
    }
    return { caseId, label, result };
  });
  const agreed = agreement(cases);
  const rate = agreed.total === 0 ? 0 : agreed.matched / agreed.total;
  return {
    recorded: true,
    cases,
    agreement: agreed,
    costUsd: cases.reduce((sum, item) => sum + item.result.costUsd, 0),
    minAgreement,
    meetsBaseline: agreed.total > 0 && rate >= minAgreement,
  };
}

/** Replays the judge cassette over the replayed eval, or records a new one with `record`. */
export async function runJudge(
  workspace = root,
  options: { readonly record: boolean; readonly env: Record<string, string | undefined>; readonly log?: (line: string) => void } = {
    record: false,
    env: process.env,
  },
): Promise<JudgeReport> {
  const { minAgreement } = baselineSchema.parse(JSON.parse(readFileSync(join(workspace, "evals", "judge-baseline.json"), "utf8")));
  const labels = loadLabels(workspace);
  const cassettePath = join(workspace, JUDGE_CASSETTE);
  if (!options.record && !existsSync(cassettePath)) {
    return { recorded: false, labels, minAgreement };
  }
  if (options.record && !options.env.ANTHROPIC_API_KEY) {
    throw new Error("eval:judge -- --record calls the Message Batches API and needs ANTHROPIC_API_KEY");
  }
  const items = loadCases(workspace);
  const runs = (await runEval(workspace)).cases;
  const subjects = items.map((item, index) => {
    const run = runs[index];
    if (run?.id !== item.id) {
      throw new Error(`${item.id}: the eval returned no run`);
    }
    return subjectOf(item, run);
  });
  const results = options.record
    ? await recordJudge(subjects, { cassettePath, env: options.env, pollMs: 30_000, log: options.log })
    : replayJudge(subjects, cassettePath);
  return judgeReport(results, labels, minAgreement);
}

export function formatJudgeReport(report: JudgeReport): string {
  const header = ["Judge eval", `judge: ${JUDGE_MODEL} at ${JUDGE_EFFORT} effort, one Message Batches request per case`];
  if (!report.recorded) {
    return [
      ...header,
      `cases: ${report.labels.size}`,
      alwaysPass([...report.labels.values()]),
      `baseline: ${percent(report.minAgreement)}`,
      `judge cassette: not recorded. Run pnpm eval:judge -- --record with ANTHROPIC_API_KEY to grade the runs.`,
    ].join("\n");
  }
  const { agreement: agreed } = report;
  const lines = [
    ...header,
    `cases: ${report.cases.length}`,
    `judge agreement: ${ratio(agreed)}`,
    alwaysPass(report.cases.map((item) => item.label)),
    `fail labels caught: ${agreed.failsCaught.matched}/${agreed.failsCaught.total}`,
    `baseline: ${percent(report.minAgreement)}`,
    ...JUDGE_CRITERIA.map((criterion) => `  ${criterion}: ${agreed.byCriterion[criterion].matched}/${agreed.byCriterion[criterion].total}`),
    `ungraded cases: ${report.cases.filter((item) => item.result.outcome === "error").length}`,
    `judge cost: ${report.costUsd.toFixed(6)} USD at the batch rate`,
  ];
  for (const item of report.cases) {
    if (item.result.outcome === "error") {
      lines.push(`${item.caseId} ungraded: ${item.result.error}`);
      continue;
    }
    lines.push(item.caseId);
    for (const criterion of JUDGE_CRITERIA) {
      const { verdict, reason } = item.result.verdict[criterion];
      const label = item.label[criterion];
      lines.push(`  ${criterion}: ${verdict}${verdict === label ? "" : ` MISMATCH (label ${label})`}. ${reason}`);
    }
  }
  return lines.join("\n");
}

export function exitCode(report: JudgeReport): 0 | 1 {
  return !report.recorded || report.meetsBaseline ? 0 : 1;
}

/** The agreement a judge that passes everything would get: the share of labels that are pass. */
function alwaysPass(labels: readonly Label[]): string {
  const total = labels.length * JUDGE_CRITERIA.length;
  const passes = labels.flatMap((label) => JUDGE_CRITERIA.filter((criterion) => label[criterion] === "pass")).length;
  return `always-pass agreement: ${ratio({ matched: passes, total })}`;
}

function ratio(count: Count): string {
  return `${count.matched}/${count.total} (${percent(count.total === 0 ? 0 : count.matched / count.total)})`;
}

function requestHash(request: ReturnType<typeof judgeRequest>): string {
  return createHash("sha256").update(JSON.stringify(request.params)).digest("hex");
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

if (isDirectRun(import.meta.url)) {
  const args = scriptArgs();
  if (args.some((arg) => arg !== "--record")) {
    process.stderr.write("usage: pnpm eval:judge [-- --record]\n");
    process.exitCode = 1;
  } else {
    runJudge(root, { record: args.includes("--record"), env: process.env, log: (line) => process.stdout.write(`${line}\n`) })
      .then((report) => {
        const text = `${formatJudgeReport(report)}\n`;
        process.stdout.write(text);
        const reportPath = process.env.THIN_PR_JUDGE_REPORT;
        if (reportPath) {
          mkdirSync(dirname(reportPath), { recursive: true });
          writeFileSync(reportPath, text);
        }
        process.exitCode = exitCode(report);
      })
      .catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : "judge failed"}\n`);
        process.exitCode = 1;
      });
  }
}
