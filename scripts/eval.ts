import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measureDiff, parseBudget, type FileChange } from "@thin-pr/gate";
import { readLabelEvent, runAction, type GitHubSurface } from "@thin-pr/github";
import { implementerOutput, ReplayModelClient } from "@thin-pr/specialists";
import { z } from "zod";

type CaseReport = {
  readonly id: string;
  readonly gate: "pass" | "fail";
  readonly files: number;
  readonly lines: number;
  readonly withinBudget: boolean;
};

type RangeStat = {
  readonly min: number;
  readonly median: number;
  readonly max: number;
};

type EvalReport = {
  readonly cases: readonly CaseReport[];
  readonly passed: number;
  readonly total: number;
  readonly passRate: number;
  readonly minPassRate: number;
  readonly withinBudget: number;
  readonly budget: { readonly maxFiles: number; readonly maxLines: number };
  readonly files: RangeStat;
  readonly lines: RangeStat;
  readonly meetsBaseline: boolean;
};

/** Recorded model replies, keyed by the step that asked for them. */
const recordingSchema = z.object({
  plan: z.unknown(),
  implement: z.unknown(),
  test: z.unknown(),
  review: z.unknown(),
  pullRequest: z.unknown(),
});

const responseSchema = recordingSchema.extend({ changes: z.array(z.string().min(1)).min(1) });

const baselineSchema = z.object({ minPassRate: z.number().gt(0).lte(1) });

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type ReplayCase = z.infer<typeof recordingSchema> & {
  readonly id: string;
  readonly payload: unknown;
  readonly issueNumber: number;
  readonly issueTitle: string;
  readonly issueBody: string;
  readonly changePaths: readonly string[];
  readonly changes: readonly FileChange[];
  readonly files: number;
  readonly lines: number;
  readonly withinBudget: boolean;
  readonly maxFiles: number;
  readonly maxLines: number;
};

export function loadReplayCases(workspace = root): ReplayCase[] {
  const evalsDir = join(workspace, "evals");
  const budget = parseBudget(jsonFile(join(evalsDir, "budget.json")));
  const sampleRoot = join(evalsDir, "sample-repo");
  const ids = issueIds(join(evalsDir, "issues"));
  if (ids.length < 10) {
    throw new Error(`evals need at least 10 issues, found ${ids.length}`);
  }

  const cases: ReplayCase[] = [];
  const seenIssues = new Set<number>();
  for (const id of ids) {
    const payload = jsonFile(join(evalsDir, "issues", `${id}.json`));
    const response = readResponse(id, jsonFile(join(evalsDir, "responses", `${id}.json`)));
    const event = readLabelEvent(payload);
    if (event.repo !== "sample-repo") {
      throw new Error(`${id}: issue repository must be sample-repo`);
    }
    if (seenIssues.has(event.issue.number)) {
      throw new Error(`${id}: duplicate issue number ${event.issue.number}`);
    }
    seenIssues.add(event.issue.number);
    const changes = readChanges(id, sampleRoot, join(evalsDir, "diffs", id), response.changes);
    const diff = measureDiff(changes);
    cases.push({
      id,
      payload,
      issueNumber: event.issue.number,
      issueTitle: event.issue.title,
      issueBody: event.issue.body,
      plan: response.plan,
      implement: response.implement,
      test: response.test,
      review: response.review,
      pullRequest: response.pullRequest,
      changePaths: response.changes,
      changes,
      files: diff.files,
      lines: diff.lines,
      withinBudget: diff.files <= budget.maxFiles && diff.lines <= budget.maxLines,
      maxFiles: budget.maxFiles,
      maxLines: budget.maxLines,
    });
  }
  return cases;
}

export async function runEval(workspace = root): Promise<EvalReport> {
  const minPassRate = readMinPassRate(join(workspace, "evals", "baseline.json"));
  const loaded = loadReplayCases(workspace);
  const first = loaded[0];
  if (!first) {
    throw new Error("evals need at least 10 issues, found 0");
  }

  const directory = mkdtempSync(join(tmpdir(), "thin-pr-eval-"));
  try {
    const cases: CaseReport[] = [];
    for (const item of loaded) {
      const gate = await replay(workspace, directory, item);
      cases.push({
        id: item.id,
        gate,
        files: item.files,
        lines: item.lines,
        withinBudget: item.withinBudget,
      });
    }
    return summarize(cases, minPassRate, { maxFiles: first.maxFiles, maxLines: first.maxLines });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function meetsBaseline(passed: number, total: number, minPassRate: number): boolean {
  if (total <= 0) {
    return false;
  }
  return passed / total >= minPassRate;
}

export function formatReport(report: EvalReport): string {
  const lines = [
    "Replay eval",
    `cases: ${report.total}`,
    `gate pass rate: ${report.passed}/${report.total} (${percent(report.passRate)})`,
    `baseline: ${percent(report.minPassRate)}`,
    `diff budget: ${report.budget.maxFiles} files, ${report.budget.maxLines} lines`,
    `within budget: ${report.withinBudget}/${report.total}`,
    `files changed: min ${formatNumber(report.files.min)}, median ${formatNumber(report.files.median)}, max ${formatNumber(report.files.max)}`,
    `lines changed: min ${formatNumber(report.lines.min)}, median ${formatNumber(report.lines.median)}, max ${formatNumber(report.lines.max)}`,
  ];
  for (const item of report.cases) {
    const budget = item.withinBudget ? "within budget" : "over budget";
    lines.push(`${item.id} ${item.gate} files ${item.files} lines ${item.lines} ${budget}`);
  }
  return lines.join("\n");
}

export function exitCode(report: EvalReport): 0 | 1 {
  return report.meetsBaseline ? 0 : 1;
}

/** The `minPassRate` floor from a baseline file. */
export function readMinPassRate(path: string): number {
  return baselineSchema.parse(jsonFile(path)).minPassRate;
}

/** A replay client that answers each specialist with its recorded reply. */
export function replayModel(value: unknown): ReplayModelClient {
  const recording = recordingSchema.parse(value);
  return new ReplayModelClient({
    planner: JSON.stringify(recording.plan),
    implementer: JSON.stringify(recording.implement),
    tester: JSON.stringify(recording.test),
    reviewer: JSON.stringify(recording.review),
    "pr-writer": JSON.stringify(recording.pullRequest),
  });
}

function summarize(
  cases: readonly CaseReport[],
  minPassRate: number,
  budget: EvalReport["budget"],
): EvalReport {
  const passed = cases.filter((item) => item.gate === "pass").length;
  const total = cases.length;
  const passRate = passed / total;
  return {
    cases,
    passed,
    total,
    passRate,
    minPassRate,
    withinBudget: cases.filter((item) => item.withinBudget).length,
    budget,
    files: rangeStat(cases.map((item) => item.files)),
    lines: rangeStat(cases.map((item) => item.lines)),
    meetsBaseline: meetsBaseline(passed, total, minPassRate),
  };
}

async function replay(workspace: string, directory: string, item: ReplayCase): Promise<"pass" | "fail"> {
  let result: Awaited<ReturnType<typeof runAction>>;
  try {
    result = await runAction({
      payload: item.payload,
      workspace,
      runId: `eval-${item.issueNumber}`,
      logPath: join(directory, `${item.id}.sqlite`),
      github: replayGitHub(),
      changes: item.changes,
      model: replayModel(item),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "replay failed";
    throw new Error(`${item.id}: ${message}`, { cause: error });
  }
  if (result.status === "ignored") {
    throw new Error(`${item.id}: issue is not a thin-pr label event`);
  }
  return result.status === "opened" ? "pass" : "fail";
}

export function replayGitHub(): GitHubSurface {
  let nextId = 1;
  return {
    async branchSha() {
      return "abc123";
    },
    async createBranch() {
      return undefined;
    },
    async startCheck() {
      const id = nextId;
      nextId += 1;
      return id;
    },
    async finishCheck() {
      return undefined;
    },
    async comment() {
      return undefined;
    },
    async readText() {
      return null;
    },
    async commitFiles() {
      return "def456";
    },
    async openDraft(input) {
      return {
        number: 1,
        url: `https://example.test/${input.owner}/${input.repo}/pull/1`,
      };
    },
  };
}

function readChanges(id: string, sampleRoot: string, diffRoot: string, paths: readonly string[]): FileChange[] {
  return paths.map((rel) => ({
    path: rel,
    before: readTreeFile(id, sampleRoot, rel, true),
    after: readTreeFile(id, diffRoot, rel, false),
  }));
}

function readTreeFile(id: string, tree: string, rel: string, allowMissing: boolean): string {
  const full = resolve(tree, rel);
  const fromRoot = relative(resolve(tree), full);
  if (fromRoot === "" || fromRoot.startsWith("..")) {
    throw new Error(`${id}: diff path escapes the tree: ${rel}`);
  }
  if (!existsSync(full)) {
    if (!allowMissing) {
      throw new Error(`${id}: missing recorded file ${rel}`);
    }
    const parent = dirname(full);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new Error(`${id}: ${rel} is outside the sample repo`);
    }
    return "";
  }
  if (!statSync(full).isFile()) {
    throw new Error(`${id}: ${rel} is not a file`);
  }
  return readFileSync(full, "utf8");
}

function readResponse(id: string, value: unknown): z.infer<typeof responseSchema> {
  const response = responseSchema.parse(value);
  if (new Set(response.changes).size !== response.changes.length) {
    throw new Error(`${id}: duplicate diff path`);
  }
  const implement = implementerOutput.safeParse(response.implement);
  if (implement.success && !samePaths(implement.data.files, response.changes)) {
    throw new Error(`${id}: implement files do not match the recorded diff`);
  }
  return response;
}

function issueIds(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

function rangeStat(values: readonly number[]): RangeStat {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  const median = sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
  return {
    min: sorted[0] ?? 0,
    median,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

function jsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  runEval()
    .then((report) => {
      process.stdout.write(`${formatReport(report)}\n`);
      process.exitCode = exitCode(report);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "eval failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
