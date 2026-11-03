import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLabelEvent, runLocal, verdictOf } from "@thin-pr/github";
import { createAnthropicClient } from "@thin-pr/specialists";
import { createScratchRepo } from "@thin-pr/workspace";
import { z } from "zod";

const EVALS = fileURLToPath(new URL("../../../evals", import.meta.url));

const expectedSchema = z
  .object({ verdict: z.enum(["opened", "awaiting_approval", "blocked"]), failedRules: z.array(z.string()).min(1).optional() })
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
  // The hidden tests go in with the base, where pnpm eval copies them in before verify, so the requests differ from
  // the recording. The replay serves the recorded replies without comparing requests and reaches the same verdict.
  const repo = createScratchRepo({ ...readTree(join(EVALS, sample), ""), ...readTree(join(dir, "hidden"), "test/hidden/") });
  try {
    const result = await runLocal({
      repo: repo.dir,
      issue: `${issue.title}\n\n${issue.body}`,
      model: () => createAnthropicClient({ mode: "replay", cassettePath: join(dir, "cassette.jsonl"), checkRequests: false }),
    });
    const verdict = verdictOf(result.status);
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
