import type { GateRuleResult } from "@thin-pr/gate";
import type { GitHubSurface } from "./surface.js";

const CONCLUSIONS = { PASS: "success", FAIL: "failure", NEEDS_APPROVAL: "neutral" } as const;

/**
 * Posts one finished check per gate rule on `sha`, the commit the run pushed. Nothing goes on the base commit: it is
 * the default branch's head, and a blocked run's checks there would mark that branch red.
 */
export async function postRuleChecks(
  github: GitHubSurface,
  target: { readonly owner: string; readonly repo: string },
  results: readonly GateRuleResult[],
  sha: string,
): Promise<void> {
  for (const result of results) {
    await github.postCheck({
      owner: target.owner,
      repo: target.repo,
      name: `thin-pr / gate / ${result.rule}`,
      sha,
      conclusion: CONCLUSIONS[result.verdict],
      summary: `${result.verdict}: ${result.reason}`,
      title: result.verdict,
    });
  }
}
