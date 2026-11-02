import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Octokit } from "@octokit/rest";
import { clientOptionsFromEnv, createAnthropicClient, type ModelSession } from "@thin-pr/specialists";
import { runAction, type LabelRunResult } from "./run.js";
import { createGitHubSurface } from "./surface.js";

export type LabeledIssueRun = {
  readonly result: LabelRunResult;
  /** Model spend in USD, or null when no live session started. */
  readonly spentUsd: number | null;
};

/**
 * The wiring the Action and the GitHub App runner share. One token authenticates the GitHub API and the push.
 * A labeled issue asks for a real change, so the model is live unless `THIN_PR_MODEL` says otherwise.
 */
export async function runLabeledIssue(input: {
  readonly payload: unknown;
  /** A checkout whose HEAD is `baseSha`, with `origin` pointing at the repository. */
  readonly checkout: string;
  readonly baseSha: string;
  readonly token: string;
  readonly runId: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<LabeledIssueRun> {
  const env: Readonly<Record<string, string | undefined>> = {
    ...input.env,
    THIN_PR_MODEL: input.env.THIN_PR_MODEL || "live",
  };
  const options = clientOptionsFromEnv(env);
  const sessions: ModelSession[] = [];
  const result = await runAction({
    payload: input.payload,
    templates: fileURLToPath(new URL("../../../templates", import.meta.url)),
    checkout: input.checkout,
    baseSha: input.baseSha,
    pushToken: input.token,
    runId: input.runId,
    logPath: join(tmpdir(), `thin-pr-${input.runId}.sqlite`),
    // GitHub Actions sets GITHUB_API_URL. Elsewhere it is unset and Octokit uses api.github.com.
    github: createGitHubSurface(new Octokit({ auth: input.token, baseUrl: env.GITHUB_API_URL })),
    model: () => {
      if (options.mode !== "replay" && !env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY is missing. Add it to the thin-pr workflow secrets or the Worker secrets.");
      }
      const session = createAnthropicClient(options, env);
      sessions.push(session);
      return session;
    },
  });
  const session = sessions[0];
  return { result, spentUsd: session && options.mode !== "replay" ? session.meter.spentUsd : null };
}
