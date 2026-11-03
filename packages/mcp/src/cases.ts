import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLabelEvent, runLocal } from "@thin-pr/github";
import { createAnthropicClient } from "@thin-pr/specialists";
import { createScratchRepo } from "@thin-pr/workspace";
import { z } from "zod";

const EVALS = fileURLToPath(new URL("../../../evals", import.meta.url));

const expectedSchema = z
  .object({ verdict: z.enum(["opened", "blocked"]), failedRules: z.array(z.string()).min(1).optional() })
  .strict();

/**
 * Replays one eval case through the same local run as `start_run`, on a scratch copy of the sample repo its issue
 * names, such as `evals/sample-repo`, and compares the verdict with the case's `expected.json`.
 */
export async function replayCase(caseId: string) {
  const ids = readdirSync(join(EVALS, "cases")).sort();
  if (!ids.includes(caseId)) {
    throw new Error(`unknown case ${caseId}. Cases: ${ids.join(", ")}`);
  }
  const dir = join(EVALS, "cases", caseId);
  const { repo: sample, issue } = readLabelEvent(readJson(join(dir, "issue.json")));
  const expected = expectedSchema.parse(readJson(join(dir, "expected.json")));
  // Replay ignores what the tools return, so hidden tests committed with the base give the verdict pnpm eval gives
  // when it copies them in before verify.
  const repo = createScratchRepo({ ...readTree(join(EVALS, sample), ""), ...readTree(join(dir, "hidden"), "test/hidden/") });
  try {
    const result = await runLocal({
      repo: repo.dir,
      issue: `${issue.title}\n\n${issue.body}`,
      model: () => createAnthropicClient({ mode: "replay", cassettePath: join(dir, "cassette.jsonl") }),
    });
    const verdict = result.status === "opened" ? "opened" : "blocked";
    const failedRules = result.record.gate.filter((rule) => rule.verdict === "FAIL").map((rule) => rule.rule);
    const rulesMatch = !expected.failedRules || [...expected.failedRules].sort().join() === [...failedRules].sort().join();
    return {
      caseId,
      expected,
      verdict,
      failedRules,
      correct: verdict === expected.verdict && rulesMatch,
      record: result.record,
    };
  } finally {
    repo.remove();
  }
}

/** Every file under `dir`, keyed by `prefix` plus its path relative to `dir`. A missing directory has none. */
function readTree(dir: string, prefix: string): Record<string, string> {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  } catch {
    return {};
  }
  return Object.fromEntries(
    entries
      .filter((path) => statSync(join(dir, path)).isFile())
      .map((path) => [`${prefix}${path.split("\\").join("/")}`, readFileSync(join(dir, path), "utf8")]),
  );
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
