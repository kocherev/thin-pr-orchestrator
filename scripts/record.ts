import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropicClient, spendLimitFrom, type ModelSession } from "@thin-pr/specialists";
import { isDirectRun, loadCases, runCases, scriptArgs } from "./eval.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export type RecordResult = {
  readonly recorded: readonly string[];
  readonly spentUsd: number;
  /** The case that hit the spend limit. Its old cassette stays, and no later case runs. */
  readonly stoppedAt: string | null;
};

/**
 * Runs the named cases against the live API, one at a time, and rewrites each case's cassette. `"all"` means every
 * case expected to open or to wait for approval. The cases expected to block replay scripted failures, so they keep their cassettes.
 * One spend limit covers the whole recording.
 */
export async function recordCases(input: {
  readonly workspace?: string;
  readonly cases: readonly string[] | "all";
  readonly env: Record<string, string | undefined>;
  /** Upstream fetch. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  readonly log?: (line: string) => void;
}): Promise<RecordResult> {
  const workspace = input.workspace ?? root;
  const log = input.log ?? (() => {});
  const apiKey = input.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("eval:record calls the live API and needs ANTHROPIC_API_KEY");
  }
  const limitUsd = spendLimitFrom(input.env);
  const all = loadCases(workspace);
  if (input.cases !== "all" && input.cases.length === 0) {
    throw new Error("usage: pnpm eval:record <caseId...|--all>");
  }
  const known = new Set(all.map((item) => item.id));
  const unknown = input.cases === "all" ? [] : input.cases.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`no eval case named ${unknown.join(", ")}`);
  }
  const items =
    input.cases === "all" ? all.filter((item) => item.expected.verdict !== "blocked") : all.filter((item) => input.cases.includes(item.id));

  const recorded: string[] = [];
  let spentUsd = 0;
  for (const item of items) {
    // Recorded to a scratch file first, so a run cut off by the spend limit leaves the old cassette in place.
    const scratch = mkdtempSync(join(tmpdir(), "thin-pr-record-"));
    const cassettePath = join(scratch, "cassette.jsonl");
    const sessions: ModelSession[] = [];
    try {
      const [result] = await runCases(
        workspace,
        [item],
        () => {
          const session = createAnthropicClient(
            { mode: "record", cassettePath, apiKey, spendLimitUsd: limitUsd - spentUsd, fetch: input.fetch },
            input.env,
          );
          sessions.push(session);
          return session;
        },
        1,
      );
      const caseSpend = sessions.reduce((sum, session) => sum + session.meter.spentUsd, 0);
      spentUsd += caseSpend;
      if (result?.error?.includes("model spend would pass")) {
        log(`${item.id} stopped at the ${limitUsd} USD limit after ${usd(caseSpend)}. Its cassette is unchanged.`);
        return { recorded, spentUsd, stoppedAt: item.id };
      }
      copyFileSync(cassettePath, item.cassette);
      recorded.push(item.id);
      log(`${item.id} ${result?.actual ?? "failed"} ${usd(caseSpend)}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return { recorded, spentUsd, stoppedAt: null };
}

function usd(amount: number): string {
  return `${amount.toFixed(6)} USD`;
}

if (isDirectRun(import.meta.url)) {
  const args = scriptArgs();
  const cases = args.length === 1 && args[0] === "--all" ? "all" : args;
  recordCases({ cases, env: process.env, log: (line) => process.stdout.write(`${line}\n`) })
    .then((result) => {
      process.stdout.write(`recorded ${result.recorded.length} cases, live spend ${usd(result.spentUsd)}\n`);
      if (result.recorded.length > 0) {
        process.stdout.write("Run pnpm eval -- --write to refresh evals/report.json and evals/runs/.\n");
      }
      process.exitCode = result.stoppedAt === null ? 0 : 1;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "recording failed"}\n`);
      process.exitCode = 1;
    });
}
