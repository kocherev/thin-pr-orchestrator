import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openEventLog, replay, templateForLabel, type RunState, type StepHandler } from "@thin-pr/core";
import { GATE_RULES } from "@thin-pr/gate";
import {
  createRunHandlers,
  noReadBack,
  readLabelEvent,
  runIssue,
  verdictOf,
  type GitHubSurface,
  type RunRecord,
  type Verdict,
} from "@thin-pr/github";
import { createAnthropicClient, stableText, type ModelSession } from "@thin-pr/specialists";
import { createScratchRepo, loadRepoConfig, openWorkspace } from "@thin-pr/workspace";
import { z } from "zod";

const expectedSchema = z
  .object({
    verdict: z.enum(["opened", "awaiting_approval", "blocked"]),
    failedRules: z.array(z.enum(GATE_RULES)).min(1).optional(),
  })
  .strict();

const baselineSchema = z.object({ minVerdictAccuracy: z.number().gt(0).lte(1) }).strict();

const cassetteTime = z.looseObject({ recordedAt: z.iso.datetime().optional() });

type File = { readonly path: string; readonly content: string };

/** The sample repos under `evals/`. A case runs on the one its issue's repository names. */
const SAMPLE_REPOS = ["sample-repo", "sample-python"];

// sample-python uses `bool | None`, which Python 3.10 added.
const MIN_PYTHON = [3, 10] as const;

export type EvalCase = {
  readonly id: string;
  /** The sample repo under `evals/` the case runs on. */
  readonly repo: string;
  readonly payload: unknown;
  readonly issueTitle: string;
  readonly issueBody: string;
  /** The recorded model calls, replayed in order per specialist. */
  readonly cassette: string;
  /** When the cassette's first call was recorded, or null before the first recording. Run records start here. */
  readonly recordedAt: string | null;
  /** Tests copied into `test/hidden/` right before verify. The implementer never sees them. */
  readonly hidden: readonly File[];
  readonly expected: z.infer<typeof expectedSchema>;
};

export type CaseResult = {
  readonly id: string;
  readonly title: string;
  readonly expected: EvalCase["expected"];
  /** The run status. A failed run counts as blocked for the verdict. */
  /** A replayed case never reaches a command, so it is never cancelled. */
  readonly actual: Exclude<RunRecord["status"], "cancelled">;
  readonly verdict: Verdict;
  readonly failedRules: readonly string[];
  /** The step error when the run failed before the gate. */
  readonly error: string | null;
  readonly correct: boolean;
  /** The run record with recorded durations and machine-independent check logs. */
  readonly record: RunRecord;
  /** Each step's last output, rebuilt from the run log. */
  readonly outputs: RunState["outputs"];
};

/** The model session a case runs with. Evals replay each case's cassette. */
export type SessionFor = (item: EvalCase) => ModelSession;

const replayCassette: SessionFor = (item) => createAnthropicClient({ mode: "replay", cassettePath: item.cassette });

type ModelTotals = {
  readonly model: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
};

export type Scores = {
  readonly correct: number;
  readonly total: number;
  readonly accuracy: number;
  /** Cases expected to open that did open. */
  readonly resolved: { readonly count: number; readonly total: number };
  readonly blocked: { readonly count: number; readonly total: number };
  /** Cases expected to wait for approval that did. */
  readonly awaiting: { readonly count: number; readonly total: number };
  /** Spend on the cases expected to open, divided by the ones that opened. Null when none did. */
  readonly costPerResolvedUsd: number | null;
  /** Median duration of the steps that called a model, by nearest rank. Null when no step did. */
  readonly p50StepMs: number | null;
  readonly byModel: readonly ModelTotals[];
};

export type EvalReport = Scores & {
  readonly cases: readonly CaseResult[];
  readonly minVerdictAccuracy: number;
  readonly meetsBaseline: boolean;
};

/** `evals/report.json`. The console reads it. */
export type ReportFile = {
  readonly version: 1;
  readonly generatedAt: string;
  readonly cases: readonly {
    readonly caseId: string;
    readonly title: string;
    readonly expected: Verdict;
    /** A replayed case never reaches a command, so it is never cancelled. */
  readonly actual: Exclude<RunRecord["status"], "cancelled">;
    readonly failedRules: readonly string[];
    readonly costUsd: number;
    readonly durationMs: number;
    readonly models: readonly string[];
  }[];
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const REPORT_PATH = "evals/report.json";
const RUNS_DIR = "evals/runs";

export function loadCases(workspace = root): EvalCase[] {
  const casesDir = join(workspace, "evals", "cases");
  const seen = new Set<string>();
  return readdirSync(casesDir)
    .sort()
    .map((id) => {
      const dir = join(casesDir, id);
      const payload = jsonFile(join(dir, "issue.json"));
      const event = readLabelEvent(payload);
      const key = `${event.repo}#${event.issue.number}`;
      if (!SAMPLE_REPOS.includes(event.repo) || seen.has(key)) {
        throw new Error(`${id}: the issue must be a unique number on ${SAMPLE_REPOS.join(" or ")}`);
      }
      seen.add(key);
      const cassette = join(dir, "cassette.jsonl");
      return {
        id,
        repo: event.repo,
        payload,
        issueTitle: event.issue.title,
        issueBody: event.issue.body,
        cassette,
        recordedAt: existsSync(cassette) ? firstRecordedAt(id, cassette) : null,
        hidden: readTree(join(dir, "hidden")),
        expected: expectedSchema.parse(jsonFile(join(dir, "expected.json"))),
      };
    });
}

/**
 * Runs every case through the labeled-issue path on a scratch copy of its sample repo. The model calls replay from
 * each case's cassette. Typecheck and tests run for real, with this repo's `tsc` and `vitest` on PATH and `python3`
 * from the machine.
 */
export async function runEval(workspace = root, sessionFor: SessionFor = replayCassette): Promise<EvalReport> {
  const { minVerdictAccuracy } = baselineSchema.parse(jsonFile(join(workspace, "evals", "baseline.json")));
  // Each case has its own scratch repo, so a few run at once.
  const cases = await runCases(workspace, loadCases(workspace), sessionFor, Math.max(1, Math.floor(availableParallelism() / 2)));
  const scores = scoreRuns(cases);
  return { ...scores, cases, minVerdictAccuracy, meetsBaseline: cases.length > 0 && scores.accuracy >= minVerdictAccuracy };
}

/** Runs `items` with up to `parallel` at once. Results keep the order of `items`. */
export async function runCases(
  workspace: string,
  items: readonly EvalCase[],
  sessionFor: SessionFor,
  parallel: number,
): Promise<CaseResult[]> {
  const logs = mkdtempSync(join(tmpdir(), "thin-pr-eval-"));
  const restore = pinEnv({
    PATH: [join(workspace, "node_modules", ".bin"), process.env.PATH].join(delimiter),
    // The checks inherit this environment. CI runners and local shells differ in these, and vitest reads them.
    CI: "true",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
  });
  try {
    if (items.some((item) => item.repo === "sample-python")) {
      requirePython();
    }
    const cases: CaseResult[] = [];
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item) {
          cases[index] = await runCase(workspace, item, logs, () => sessionFor(item));
        }
      }
    };
    await Promise.all(Array.from({ length: parallel }, worker));
    return cases;
  } finally {
    restore();
    rmSync(logs, { recursive: true, force: true });
  }
}

/** Throws unless `python3` on PATH is Python 3.10 or later. */
function requirePython(): void {
  const probe = spawnSync("python3", ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    throw new Error(`evals/sample-python runs its checks with python3, and python3 is not on PATH. Install Python ${MIN_PYTHON.join(".")} or later.`);
  }
  const version = probe.stdout.trim();
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major < MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor < MIN_PYTHON[1])) {
    throw new Error(`evals/sample-python needs Python ${MIN_PYTHON.join(".")} or later, and python3 is ${version}.`);
  }
}

/** Sets or unsets each variable in `process.env`, and returns a function that puts the old values back. */
function pinEnv(values: Readonly<Record<string, string | undefined>>): () => void {
  const saved = Object.keys(values).map((name) => [name, process.env[name]] as const);
  const apply = (entries: readonly (readonly [string, string | undefined])[]) => {
    for (const [name, value] of entries) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
  apply(Object.entries(values));
  return () => apply(saved);
}

export function scoreRuns(
  cases: readonly Pick<CaseResult, "expected" | "verdict" | "correct" | "record">[],
): Scores {
  const correct = cases.filter((item) => item.correct).length;
  const good = cases.filter((item) => item.expected.verdict === "opened");
  const bad = cases.filter((item) => item.expected.verdict === "blocked");
  const big = cases.filter((item) => item.expected.verdict === "awaiting_approval");
  const resolved = good.filter((item) => item.verdict === "opened").length;
  const goodSpend = good.reduce((sum, item) => sum + item.record.totals.costUsd, 0);
  const modelSteps = cases.flatMap((item) => item.record.steps.filter((step) => step.usage.length > 0));
  const durations = modelSteps.map((step) => step.durationMs).sort((a, b) => a - b);
  const byModel = new Map<string, ModelTotals>();
  for (const usage of modelSteps.flatMap((step) => step.usage)) {
    const sum = byModel.get(usage.model) ?? { model: usage.model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    byModel.set(usage.model, {
      model: usage.model,
      calls: sum.calls + 1,
      inputTokens: sum.inputTokens + usage.inputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      costUsd: sum.costUsd + usage.costUsd,
    });
  }
  return {
    correct,
    total: cases.length,
    accuracy: cases.length === 0 ? 0 : correct / cases.length,
    resolved: { count: resolved, total: good.length },
    blocked: { count: bad.filter((item) => item.verdict === "blocked").length, total: bad.length },
    awaiting: { count: big.filter((item) => item.verdict === "awaiting_approval").length, total: big.length },
    costPerResolvedUsd: resolved === 0 ? null : goodSpend / resolved,
    p50StepMs: durations[Math.ceil(durations.length / 2) - 1] ?? null,
    byModel: [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model)),
  };
}

export function formatReport(report: EvalReport): string {
  const failed = new Set(report.cases.flatMap((item) => item.failedRules));
  const lines = [
    "Replay eval",
    `cases: ${report.total}`,
    `verdict accuracy: ${ratio(report.correct, report.total)}`,
    `resolve rate: ${ratio(report.resolved.count, report.resolved.total)}`,
    `cost per resolved case: ${report.costPerResolvedUsd === null ? "none resolved" : usd(report.costPerResolvedUsd)}`,
    `p50 step latency: ${report.p50StepMs === null ? "no model steps" : `${report.p50StepMs} ms`}`,
    "by model:",
    ...report.byModel.map(
      (row) =>
        `  ${row.model}: ${row.calls} calls, ${row.inputTokens} input tokens, ${row.outputTokens} output tokens, ${usd(row.costUsd)}`,
    ),
    `baseline: ${percent(report.minVerdictAccuracy)}`,
    `blocked bad: ${report.blocked.count}/${report.blocked.total}`,
    `waited for approval: ${report.awaiting.count}/${report.awaiting.total}`,
    `rules failed by a case: ${GATE_RULES.filter((rule) => failed.has(rule)).join(", ") || "none"}`,
    `rules no case fails: ${GATE_RULES.filter((rule) => !failed.has(rule)).join(", ") || "none"}`,
  ];
  for (const item of report.cases) {
    const files = item.record.diff?.files ?? [];
    const changed = files.reduce((sum, file) => sum + file.added + file.removed, 0);
    const expected = `${item.expected.verdict}${item.expected.failedRules ? ` on ${item.expected.failedRules.join(", ")}` : ""}`;
    const waiting = item.record.gate.filter((rule) => rule.verdict === "NEEDS_APPROVAL").map((rule) => rule.rule);
    const detail = item.error
      ? ` run failed: ${item.error}`
      : item.failedRules.length > 0
        ? ` failed rules: ${item.failedRules.join(", ")}`
        : waiting.length > 0
          ? ` needs approval: ${waiting.join(", ")}`
          : "";
    lines.push(
      `${item.id} ${item.verdict} ${item.correct ? "ok" : `MISMATCH (expected ${expected})`} files ${files.length} lines ${changed}${detail}`,
    );
  }
  return lines.join("\n");
}

export function exitCode(report: EvalReport): 0 | 1 {
  return report.meetsBaseline ? 0 : 1;
}

/** The committed report files for a run: `evals/report.json` and one run record per case under `evals/runs/`. */
export function reportFiles(report: EvalReport): Map<string, string> {
  const file: ReportFile = {
    version: 1,
    // The newest recording. Each record's first step starts when its cassette was recorded.
    generatedAt: report.cases.map((item) => item.record.steps[0]?.startedAt ?? "").sort().at(-1) ?? "",
    cases: report.cases.map((item) => ({
      caseId: item.id,
      title: item.title,
      expected: item.expected.verdict,
      actual: item.actual,
      failedRules: item.failedRules,
      costUsd: Number(item.record.totals.costUsd.toFixed(6)),
      durationMs: item.record.totals.durationMs,
      models: [...new Set(item.record.steps.flatMap((step) => step.usage.map((usage) => usage.model)))].sort(),
    })),
  };
  const files = new Map([[REPORT_PATH, json(file)]]);
  for (const item of report.cases) {
    files.set(`${RUNS_DIR}/${item.id}.json`, json(item.record));
  }
  return files;
}

/** Replaces `evals/runs/` and writes every report file under `workspace`. */
export function writeReportFiles(workspace: string, files: ReadonlyMap<string, string>): void {
  rmSync(join(workspace, RUNS_DIR), { recursive: true, force: true });
  for (const [path, content] of files) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), content);
  }
}

/** One line per committed report file that differs from `files`, naming the first line that differs. */
export function staleReportFiles(workspace: string, files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const runsDir = join(workspace, RUNS_DIR);
  const committedRuns = existsSync(runsDir) ? readdirSync(runsDir).map((name) => `${RUNS_DIR}/${name}`) : [];
  for (const path of committedRuns.filter((path) => !files.has(path)).sort()) {
    problems.push(`${path} has no eval case`);
  }
  for (const [path, fresh] of files) {
    const full = join(workspace, path);
    if (!existsSync(full)) {
      problems.push(`${path} is missing`);
      continue;
    }
    const committed = readFileSync(full, "utf8").split("\n");
    const lines = fresh.split("\n");
    const index = lines.findIndex((line, at) => committed[at] !== line);
    if (index >= 0 || committed.length !== lines.length) {
      const at = index >= 0 ? index : Math.min(committed.length, lines.length);
      problems.push(
        `${path} line ${at + 1} differs\n  committed: ${committed[at] ?? "(end of file)"}\n  fresh:     ${lines[at] ?? "(end of file)"}`,
      );
    }
  }
  return problems;
}

/** A GitHub surface that accepts every call and opens draft 1. Evals and traces never reach GitHub. */
export function replayGitHub(): GitHubSurface {
  let nextId = 1;
  return {
    async postCheck() {},
    async createComment() {
      nextId += 1;
      return nextId - 1;
    },
    async editComment() {},
    async branchHead() {
      return null;
    },
    async listPullsForHead() {
      return [];
    },
    async updatePull(input) {
      return { number: input.number, url: `https://example.test/${input.owner}/${input.repo}/pull/${input.number}` };
    },
    async openDraft(input) {
      return { number: 1, url: `https://example.test/${input.owner}/${input.repo}/pull/1` };
    },
    // A replayed run starts from a label, never from a command or a review, so it reads nothing back.
    ...noReadBack("a replayed run"),
  };
}

async function runCase(
  workspace: string,
  item: EvalCase,
  logs: string,
  session: () => ModelSession,
): Promise<CaseResult> {
  const sample = readTree(join(workspace, "evals", item.repo));
  const repo = createScratchRepo(Object.fromEntries(sample.map((file) => [file.path, file.content])));
  const log = openEventLog(join(logs, `${item.id}.sqlite`));
  try {
    appendFileSync(join(repo.dir, ".git", "info", "exclude"), "/test/hidden/\n");
    const event = readLabelEvent(item.payload);
    const template = templateForLabel(join(workspace, "templates"), event.label);
    if (event.action !== "labeled" || !template) {
      throw new Error("the issue is not a thin-pr label event");
    }
    const config = loadRepoConfig(repo.dir);
    const checkout = await openWorkspace({ dir: repo.dir, baseSha: repo.baseSha, config });

    const runId = `eval-${item.id}`;
    const result = await runIssue({
      event,
      template,
      config,
      workspace: checkout,
      handlers: (limits) => {
        const handlers = createRunHandlers(session(), checkout, limits);
        return { ...handlers, verify: withHiddenTests(handlers.verify, repo.dir, item.hidden) };
      },
      github: replayGitHub(),
      log,
      runId,
    });
    if (result.status === "ignored") {
      throw new Error("the run ignored the issue");
    }
    const verdict = verdictOf(result.status);
    const failedRules = result.record.gate.filter((rule) => rule.verdict === "FAIL").map((rule) => rule.rule);
    const rulesMatch = !item.expected.failedRules || sameItems(item.expected.failedRules, failedRules);
    const dirs = [realpathSync(repo.dir), repo.dir];
    return {
      id: item.id,
      title: item.issueTitle,
      expected: item.expected,
      actual: result.status,
      verdict,
      failedRules,
      error: result.status === "failed" ? stableLog(result.error, dirs) : null,
      correct: verdict === item.expected.verdict && rulesMatch,
      record: stableRecord(result.record, dirs, item.recordedAt ?? new Date(0).toISOString()),
      outputs: replay(log.read(runId)).outputs,
    };
  } catch (error) {
    throw new Error(`${item.id}: ${error instanceof Error ? error.message : "replay failed"}`, { cause: error });
  } finally {
    log.close();
    repo.remove();
  }
}

/**
 * The record with nothing that depends on the machine or the clock. Each step lasts as long as its recorded model
 * calls, and the steps run back to back from `startedAt`. Checks run for real, so their durations are dropped, and
 * their logs lose the scratch path and the vitest timings.
 */
function stableRecord(record: RunRecord, dirs: readonly string[], startedAt: string): RunRecord {
  let clock = Date.parse(startedAt);
  const steps = record.steps.map((step) => {
    const durationMs = step.usage.reduce((sum, usage) => sum + usage.durationMs, 0);
    const stable = { ...step, startedAt: new Date(clock).toISOString(), durationMs, summary: stableLog(step.summary, dirs) };
    clock += durationMs;
    return stable;
  });
  return {
    ...record,
    steps,
    checks: record.checks.map((check) => ({ ...check, durationMs: 0, logTail: stableLog(check.logTail, dirs) })),
    totals: { ...record.totals, durationMs: steps.reduce((sum, step) => sum + step.durationMs, 0) },
  };
}

function stableLog(text: string, dirs: readonly string[]): string {
  return stableText(dirs.reduce((out, dir) => out.split(dir).join("."), text));
}

function withHiddenTests(verify: StepHandler, dir: string, hidden: readonly File[]): StepHandler {
  return (context) => {
    for (const file of hidden) {
      const path = join(dir, "test", "hidden", file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
    return verify(context);
  };
}

function firstRecordedAt(id: string, cassette: string): string {
  const times = readFileSync(cassette, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => cassetteTime.parse(JSON.parse(line)).recordedAt ?? []);
  const first = times.sort()[0];
  if (!first) {
    throw new Error(`${id}: the cassette has no recordedAt`);
  }
  return first;
}

/** Every file under `dir`, with paths relative to it. A missing directory has no files. */
function readTree(dir: string): File[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return entries
    .filter((path) => statSync(join(dir, path)).isFile())
    .sort()
    .map((path) => ({ path: path.split("\\").join("/"), content: readFileSync(join(dir, path), "utf8") }));
}

function sameItems(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function jsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ratio(count: number, total: number): string {
  return `${count}/${total} (${percent(total === 0 ? 0 : count / total)})`;
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function usd(amount: number): string {
  return `${amount.toFixed(6)} USD`;
}

/** Script arguments without the `--` that `pnpm <script> -- <args>` passes through. */
export function scriptArgs(argv: readonly string[] = process.argv): string[] {
  return argv.slice(2).filter((arg) => arg !== "--");
}

export function isDirectRun(url: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(url);
}

async function main(): Promise<0 | 1> {
  const args = scriptArgs();
  const write = args.includes("--write");
  if (args.some((arg) => arg !== "--write")) {
    throw new Error("usage: pnpm eval [-- --write]");
  }
  const report = await runEval();
  process.stdout.write(`${formatReport(report)}\n`);
  const files = reportFiles(report);
  if (write) {
    writeReportFiles(root, files);
    process.stdout.write(`wrote ${REPORT_PATH} and ${report.cases.length} run records under ${RUNS_DIR}/\n`);
    return exitCode(report);
  }
  const stale = staleReportFiles(root, files);
  if (stale.length > 0) {
    process.stderr.write(`${REPORT_PATH} is stale.\n${stale.join("\n")}\nRun pnpm eval -- --write and commit ${REPORT_PATH} and ${RUNS_DIR}/.\n`);
    return 1;
  }
  process.stdout.write(`${REPORT_PATH} matches this run\n`);
  return exitCode(report);
}

if (isDirectRun(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "eval failed"}\n`);
      process.exitCode = 1;
    });
}
