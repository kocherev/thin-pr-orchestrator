import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Octokit } from "@octokit/rest";
import { clientOptionsFromEnv, createAnthropicClient, type ModelSession } from "@thin-pr/specialists";
import { runCommand, type CommandResult } from "./commands.js";
import { labelEvent, type LabelEvent } from "./event.js";
import type { Trigger } from "./router.js";
import { runLabel, type LabelRunResult } from "./run.js";
import { createGitHubSurface } from "./surface.js";

export type TriggerOutcome =
  | { readonly kind: "label"; readonly result: LabelRunResult }
  | { readonly kind: "command"; readonly result: CommandResult };

export type TriggerRun = {
  readonly outcome: TriggerOutcome;
  /** Model spend in USD, or null when no live session started. */
  readonly spentUsd: number | null;
};

/** The run a trigger started, if any: a label, or a retry command. */
export function runResultOf(outcome: TriggerOutcome): LabelRunResult | null {
  if (outcome.kind === "label") {
    return outcome.result;
  }
  return outcome.result.status === "retried" ? outcome.result.run : null;
}

/**
 * The wiring the Action and the GitHub App runner share: one router trigger, run against a checkout. One token
 * authenticates the GitHub API and the push. A run asks for a real change, so the model is live unless
 * `THIN_PR_MODEL` says otherwise.
 */
export async function runTrigger(input: {
  readonly trigger: Trigger;
  /** A checkout whose HEAD is `baseSha`, with `origin` pointing at the repository. */
  readonly checkout: string;
  readonly baseSha: string;
  readonly token: string;
  readonly runId: string;
  /** Markdown that links to where the run executes, for the progress comment. */
  readonly runLink: string | null;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<TriggerRun> {
  const env: Readonly<Record<string, string | undefined>> = {
    ...input.env,
    THIN_PR_MODEL: input.env.THIN_PR_MODEL || "live",
  };
  const options = clientOptionsFromEnv(env);
  const sessions: ModelSession[] = [];
  // GitHub Actions sets GITHUB_API_URL. Elsewhere it is unset and Octokit uses api.github.com.
  const github = createGitHubSurface(new Octokit({ auth: input.token, baseUrl: env.GITHUB_API_URL }));
  const label = (event: LabelEvent) =>
    runLabel({
      event,
      templates: fileURLToPath(new URL("../../../templates", import.meta.url)),
      checkout: input.checkout,
      baseSha: input.baseSha,
      pushToken: input.token,
      runId: input.runId,
      runLink: input.runLink,
      logPath: join(tmpdir(), `thin-pr-${input.runId}.sqlite`),
      github,
      model: () => {
        if (options.mode !== "replay" && !env.ANTHROPIC_API_KEY) {
          throw new Error("ANTHROPIC_API_KEY is missing. Add it to the thin-pr workflow secrets or the Worker secrets.");
        }
        const session = createAnthropicClient(options, env);
        sessions.push(session);
        return session;
      },
    });

  const { trigger } = input;
  const outcome: TriggerOutcome =
    trigger.kind === "label"
      ? { kind: "label", result: await label(labelEvent(trigger)) }
      : { kind: "command", result: await runCommand(trigger, { github, retry: label }) };
  const session = sessions[0];
  return { outcome, spentUsd: session && options.mode !== "replay" ? session.meter.spentUsd : null };
}
