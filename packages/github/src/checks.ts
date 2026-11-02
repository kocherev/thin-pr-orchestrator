import type { RunEvent } from "@thin-pr/core";
import type { GateRuleResult } from "@thin-pr/gate";
import { summaryOf } from "@thin-pr/specialists";
import type { GitHubSurface } from "./surface.js";

export type CheckRuns = {
  /** Opens a check when a step starts and closes it when the step finishes, loops, or the run fails. */
  onEvent(event: RunEvent, sha: string): Promise<void>;
  /** Posts one finished check per gate rule. */
  postRules(results: readonly GateRuleResult[], sha: string): Promise<void>;
  /** Closes the open check, if any, as a failure. */
  abort(message: string): Promise<void>;
};

export function createCheckRuns(
  github: GitHubSurface,
  target: { readonly owner: string; readonly repo: string },
): CheckRuns {
  let open: number | null = null;

  const close = async (conclusion: "success" | "failure", summary: string): Promise<void> => {
    if (open === null) {
      return;
    }
    const checkRunId = open;
    open = null;
    await github.finishCheck({ owner: target.owner, repo: target.repo, checkRunId, conclusion, summary });
  };

  return {
    async onEvent(event, sha) {
      if (event.step === null) {
        if (event.kind === "failed") {
          await close("failure", event.error ?? "run failed");
        }
        return;
      }
      switch (event.kind) {
        case "started":
          // A retry keeps the check its first attempt opened.
          open ??= await github.startCheck({ owner: target.owner, repo: target.repo, name: `thin-pr / ${event.step}`, sha });
          return;
        case "finished":
          return close("success", summaryOf(event.output));
        case "looped":
          return close("failure", event.feedback ?? "looped");
        case "failed":
        case "completed":
          return;
      }
    },
    async postRules(results, sha) {
      for (const result of results) {
        const checkRunId = await github.startCheck({
          owner: target.owner,
          repo: target.repo,
          name: `thin-pr / gate / ${result.rule}`,
          sha,
        });
        await github.finishCheck({
          owner: target.owner,
          repo: target.repo,
          checkRunId,
          conclusion: result.verdict === "PASS" ? "success" : "failure",
          summary: `${result.verdict}: ${result.reason}`,
          title: result.verdict,
        });
      }
    },
    abort(message) {
      return close("failure", message);
    },
  };
}
