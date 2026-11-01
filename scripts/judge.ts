import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJudge, type JudgeSubject, type JudgeVerdict } from "@thin-pr/specialists";
import { loadReplayCases } from "./eval.js";

export type JudgeCaseReport = JudgeVerdict & {
  readonly id: string;
};

export type JudgeReport = {
  readonly cases: readonly JudgeCaseReport[];
  readonly passed: number;
  readonly total: number;
  readonly passRate: number;
  readonly minPassRate: number;
  readonly meetsBaseline: boolean;
  readonly spentUsd: number | null;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function runJudge(
  workspace = root,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<JudgeReport> {
  const minPassRate = readPassRate(jsonFile(join(workspace, "evals", "judge-baseline.json")));
  const session = createJudge(env, fetchImpl);
  const cases: JudgeCaseReport[] = [];
  for (const item of loadReplayCases(workspace)) {
    const subject = subjectOf(item);
    const verdict = await session.judge(subject);
    cases.push({ id: item.id, ...verdict });
  }
  return summarize(cases, minPassRate, session.spentUsd());
}

export function judgeSubjects(workspace = root): JudgeSubject[] {
  return loadReplayCases(workspace).map(subjectOf);
}

export function formatJudgeReport(report: JudgeReport): string {
  const lines = [
    "Judge eval",
    `cases: ${report.total}`,
    `judge pass rate: ${report.passed}/${report.total} (${percent(report.passRate)})`,
    `baseline: ${percent(report.minPassRate)}`,
  ];
  if (report.spentUsd !== null) {
    lines.push(`live spend: ${report.spentUsd.toFixed(6)} USD`);
  }
  for (const item of report.cases) {
    lines.push(`${item.id} ${item.verdict}`);
    for (const reason of item.reasons) {
      lines.push(`  ${reason.rule}: ${reason.verdict}. ${reason.reason}`);
    }
  }
  return lines.join("\n");
}

export function exitCode(report: JudgeReport): 0 | 1 {
  return report.meetsBaseline ? 0 : 1;
}

export function subjectOf(item: {
  readonly id: string;
  readonly issueTitle: string;
  readonly issueBody: string;
  readonly plan: unknown;
  readonly implement: unknown;
  readonly test: unknown;
  readonly review: unknown;
  readonly changePaths: readonly string[];
  readonly files: number;
  readonly lines: number;
  readonly maxFiles: number;
  readonly maxLines: number;
}): JudgeSubject {
  return {
    id: item.id,
    issueTitle: item.issueTitle,
    issueBody: item.issueBody,
    plan: item.plan,
    implement: item.implement,
    test: item.test,
    review: item.review,
    changes: item.changePaths,
    files: item.files,
    lines: item.lines,
    maxFiles: item.maxFiles,
    maxLines: item.maxLines,
  };
}

function summarize(cases: readonly JudgeCaseReport[], minPassRate: number, spentUsd: number | null): JudgeReport {
  const passed = cases.filter((item) => item.verdict === "pass").length;
  const total = cases.length;
  const passRate = total === 0 ? 0 : passed / total;
  return {
    cases,
    passed,
    total,
    passRate,
    minPassRate,
    meetsBaseline: total > 0 && passRate >= minPassRate,
    spentUsd,
  };
}

function readPassRate(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("judge-baseline.json must be an object");
  }
  const rate = (value as Record<string, unknown>).minPassRate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 1) {
    throw new Error("judge-baseline.json minPassRate must be greater than 0 and at most 1");
  }
  return rate;
}

function jsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  runJudge()
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
      const message = error instanceof Error ? error.message : "judge failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
