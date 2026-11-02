import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openEventLog, replay, templateForLabel, type RunState, type StepHandler } from "@thin-pr/core";
import { GATE_RULES } from "@thin-pr/gate";
import { createRunHandlers, readLabelEvent, runIssue, type GitHubSurface, type RunRecord } from "@thin-pr/github";
import { createAnthropicClient, type ModelSession } from "@thin-pr/specialists";
import { createScratchRepo, loadRepoConfig, openWorkspace } from "@thin-pr/workspace";
import { z } from "zod";

type Verdict = "opened" | "blocked";

const expectedSchema = z
  .object({ verdict: z.enum(["opened", "blocked"]), failedRules: z.array(z.enum(GATE_RULES)).min(1).optional() })
  .strict();

const baselineSchema = z.object({ minVerdictAccuracy: z.number().gt(0).lte(1) }).strict();

type File = { readonly path: string; readonly content: string };

export type EvalCase = {
  readonly id: string;
  readonly payload: unknown;
  readonly issueTitle: string;
  readonly issueBody: string;
  /** The recorded model calls, replayed in order per specialist. */
  readonly cassette: string;
  /** Tests copied into `test/hidden/` right before verify. The implementer never sees them. */
  readonly hidden: readonly File[];
  readonly expected: z.infer<typeof expectedSchema>;
};

type CaseResult = {
  readonly id: string;
  readonly expected: EvalCase["expected"];
  readonly verdict: Verdict;
  readonly failedRules: readonly string[];
  /** The step error when the run failed before the gate. */
  readonly error: string | null;
  readonly correct: boolean;
  readonly record: RunRecord;
  /** Each step's last output, rebuilt from the run log. */
  readonly outputs: RunState["outputs"];
};

/** The model session a case runs with. Evals replay each case's cassette. */
export type SessionFor = (item: EvalCase) => ModelSession;

const replayCassette: SessionFor = (item) => createAnthropicClient({ mode: "replay", cassettePath: item.cassette });

type EvalReport = {
  readonly cases: readonly CaseResult[];
  readonly correct: number;
  readonly total: number;
  readonly accuracy: number;
  readonly minVerdictAccuracy: number;
  readonly good: { readonly opened: number; readonly total: number };
  readonly bad: { readonly blocked: number; readonly total: number };
  readonly meetsBaseline: boolean;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadCases(workspace = root): EvalCase[] {
  const casesDir = join(workspace, "evals", "cases");
  const seen = new Set<number>();
  return readdirSync(casesDir)
    .sort()
    .map((id) => {
      const dir = join(casesDir, id);
      const payload = jsonFile(join(dir, "issue.json"));
      const event = readLabelEvent(payload);
      if (event.repo !== "sample-repo" || seen.has(event.issue.number)) {
        throw new Error(`${id}: the issue must be a unique number on sample-repo`);
      }
      seen.add(event.issue.number);
      return {
        id,
        payload,
        issueTitle: event.issue.title,
        issueBody: event.issue.body,
        cassette: join(dir, "cassette.jsonl"),
        hidden: readTree(join(dir, "hidden")),
        expected: expectedSchema.parse(jsonFile(join(dir, "expected.json"))),
      };
    });
}

/**
 * Runs every case through the labeled-issue path on a scratch copy of `evals/sample-repo`. The model calls replay
 * from each case's cassette. Typecheck and tests run for real, with this repo's `tsc` and `vitest` on PATH.
 */
export async function runEval(workspace = root, sessionFor: SessionFor = replayCassette): Promise<EvalReport> {
  const { minVerdictAccuracy } = baselineSchema.parse(jsonFile(join(workspace, "evals", "baseline.json")));
  const sample = readTree(join(workspace, "evals", "sample-repo"));
  const logs = mkdtempSync(join(tmpdir(), "thin-pr-eval-"));
  const path = process.env.PATH;
  process.env.PATH = [join(workspace, "node_modules", ".bin"), path].join(delimiter);
  try {
    // Each case has its own scratch repo, so a few run at once. Results keep the case order.
    const items = loadCases(workspace);
    const cases: CaseResult[] = [];
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item) {
          cases[index] = await runCase(workspace, item, sample, logs, sessionFor(item));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.floor(availableParallelism() / 2)) }, worker));
    return summarize(cases, minVerdictAccuracy);
  } finally {
    process.env.PATH = path;
    rmSync(logs, { recursive: true, force: true });
  }
}

export function formatReport(report: EvalReport): string {
  const failed = new Set(report.cases.flatMap((item) => item.failedRules));
  const lines = [
    "Replay eval",
    `cases: ${report.total}`,
    `verdict accuracy: ${report.correct}/${report.total} (${percent(report.accuracy)})`,
    `baseline: ${percent(report.minVerdictAccuracy)}`,
    `opened good: ${report.good.opened}/${report.good.total}`,
    `blocked bad: ${report.bad.blocked}/${report.bad.total}`,
    `rules failed by a case: ${GATE_RULES.filter((rule) => failed.has(rule)).join(", ") || "none"}`,
    `rules no case fails: ${GATE_RULES.filter((rule) => !failed.has(rule)).join(", ") || "none"}`,
  ];
  for (const item of report.cases) {
    const files = item.record.diff?.files ?? [];
    const changed = files.reduce((sum, file) => sum + file.added + file.removed, 0);
    const expected = `${item.expected.verdict}${item.expected.failedRules ? ` on ${item.expected.failedRules.join(", ")}` : ""}`;
    const detail = item.error
      ? ` run failed: ${item.error}`
      : item.failedRules.length > 0
        ? ` failed rules: ${item.failedRules.join(", ")}`
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

/** A GitHub surface that accepts every call and opens draft 1. Evals and traces never reach GitHub. */
export function replayGitHub(): GitHubSurface {
  let nextId = 1;
  return {
    async startCheck() {
      nextId += 1;
      return nextId - 1;
    },
    async finishCheck() {},
    async comment() {},
    async listPullsForHead() {
      return [];
    },
    async updatePull(input) {
      return { number: input.number, url: `https://example.test/${input.owner}/${input.repo}/pull/${input.number}` };
    },
    async openDraft(input) {
      return { number: 1, url: `https://example.test/${input.owner}/${input.repo}/pull/1` };
    },
  };
}

async function runCase(
  workspace: string,
  item: EvalCase,
  sample: readonly File[],
  logs: string,
  session: ModelSession,
): Promise<CaseResult> {
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
    const handlers = createRunHandlers(session, checkout);
    const runId = `eval-${item.id}`;
    const result = await runIssue({
      event,
      template,
      config,
      workspace: checkout,
      handlers: { ...handlers, verify: withHiddenTests(handlers.verify, repo.dir, item.hidden) },
      github: replayGitHub(),
      log,
      runId,
    });
    if (result.status === "ignored") {
      throw new Error("the run ignored the issue");
    }
    const verdict = result.status === "opened" ? "opened" : "blocked";
    const failedRules = result.record.gate.filter((rule) => rule.verdict === "FAIL").map((rule) => rule.rule);
    const rulesMatch = !item.expected.failedRules || sameItems(item.expected.failedRules, failedRules);
    return {
      id: item.id,
      expected: item.expected,
      verdict,
      failedRules,
      error: result.status === "failed" ? result.error : null,
      correct: verdict === item.expected.verdict && rulesMatch,
      record: result.record,
      outputs: replay(log.read(runId)).outputs,
    };
  } catch (error) {
    throw new Error(`${item.id}: ${error instanceof Error ? error.message : "replay failed"}`, { cause: error });
  } finally {
    log.close();
    repo.remove();
  }
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

function summarize(cases: readonly CaseResult[], minVerdictAccuracy: number): EvalReport {
  const correct = cases.filter((item) => item.correct).length;
  const good = cases.filter((item) => item.expected.verdict === "opened");
  const bad = cases.filter((item) => item.expected.verdict === "blocked");
  const accuracy = cases.length === 0 ? 0 : correct / cases.length;
  return {
    cases,
    correct,
    total: cases.length,
    accuracy,
    minVerdictAccuracy,
    good: { opened: good.filter((item) => item.verdict === "opened").length, total: good.length },
    bad: { blocked: bad.filter((item) => item.verdict === "blocked").length, total: bad.length },
    meetsBaseline: cases.length > 0 && accuracy >= minVerdictAccuracy,
  };
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

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  runEval()
    .then((report) => {
      process.stdout.write(`${formatReport(report)}\n`);
      process.exitCode = exitCode(report);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "eval failed"}\n`);
      process.exitCode = 1;
    });
}
