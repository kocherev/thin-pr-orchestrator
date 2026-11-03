import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { clientOptionsFromEnv, createAnthropicClient } from "@thin-pr/specialists";
import { runLocal } from "./local.js";

const USAGE = `Usage: thin-pr run --repo <path> --issue <file.md | text> [--out <dir>]

Runs the issue against the committed HEAD of a local git checkout. A gate pass leaves the
change on a new local branch thin-pr/local-<n>. Nothing is pushed.

  --repo   the git checkout to change
  --issue  a file whose first line is the title, or the issue text itself
  --out    the directory for <runId>.json, default <repo>/.git/thin-pr/runs

THIN_PR_MODEL is live, record or replay (the default). Live and record need ANTHROPIC_API_KEY.
Record and replay read the cassette path from THIN_PR_CASSETTE.`;

const OPTIONS = {
  repo: { type: "string" },
  issue: { type: "string" },
  out: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/** Returns the exit code: 0 when the gate passed, 1 when the run was blocked or failed, 2 for bad arguments. */
async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "bad arguments"}\n\n${USAGE}\n`);
    return 2;
  }
  const { positionals, values } = parsed;
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (positionals.join(" ") !== "run" || !values.repo || !values.issue) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const issue = isFile(values.issue) ? readFileSync(values.issue, "utf8") : values.issue;
  const result = await runLocal({
    repo: values.repo,
    issue,
    runsDir: values.out,
    model: () => createAnthropicClient(clientOptionsFromEnv()),
  });
  const lines = [result.report, "", `Status: ${result.status}`, costLine(result.record.totals)];
  if (result.branch) {
    lines.push(`Branch: ${result.branch}`);
  }
  lines.push(`Record: ${result.recordPath}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return result.status === "opened" ? 0 : 1;
}

function costLine(totals: { costUsd: number; durationMs: number; inputTokens: number; outputTokens: number }): string {
  const tokens = (totals.inputTokens + totals.outputTokens).toLocaleString("en-US");
  return `Cost: $${totals.costUsd.toFixed(4)} · ${(totals.durationMs / 1000).toFixed(1)}s · ${tokens} tokens`;
}

// Issue text is rarely a valid path, and a long one fails stat with ENAMETOOLONG instead of ENOENT.
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "run failed"}\n`);
    process.exitCode = 1;
  },
);
