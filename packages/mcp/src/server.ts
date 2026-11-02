import { isAbsolute } from "node:path";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { runLocal } from "@thin-pr/github";
import { clientOptionsFromEnv, createAnthropicClient } from "@thin-pr/specialists";
import { z } from "zod";
import { replayCase } from "./cases.js";
import { findRun, listRuns } from "./runs.js";

/**
 * The thin-pr tools. `runsDir` is where list_runs and get_run read RunRecords and where start_run writes them.
 * A tool that throws answers with a tool error, so a bad call never stops the server.
 */
export function createServer(options: { readonly runsDir: string | undefined }): McpServer {
  const server = new McpServer({ name: "thin-pr", version: "0.0.0" });
  const runsDir = (): string => {
    if (!options.runsDir) {
      throw new Error("THIN_PR_RUNS_DIR is not set. Point it at a directory of RunRecord JSON files.");
    }
    return options.runsDir;
  };

  server.registerTool(
    "list_runs",
    {
      description:
        "List the RunRecords in THIN_PR_RUNS_DIR, newest first: run id, issue title, status (opened, blocked or " +
        "failed), a gate summary and the model cost in USD. Files that are not RunRecords are named in skipped.",
      annotations: { readOnlyHint: true },
    },
    () => json(listRuns(runsDir())),
  );

  server.registerTool(
    "get_run",
    {
      description:
        "Return one RunRecord from THIN_PR_RUNS_DIR: every step with its timing and usage, the nine gate verdicts, " +
        "the measured diff and patch, the check results and the totals.",
      inputSchema: z.object({ runId: z.string().min(1).describe("The runId that list_runs shows.") }),
      annotations: { readOnlyHint: true },
    },
    ({ runId }) => json(findRun(runsDir(), runId)),
  );

  server.registerTool(
    "replay_case",
    {
      description:
        "Replay one eval case from evals/cases offline: a scratch copy of evals/sample-repo, the case's recorded " +
        "model calls, real typecheck and test runs, and the gate. Returns the verdict, the failed gate rules, " +
        "whether they match expected.json, and the RunRecord. Calls no model API and writes nothing outside a temp dir.",
      inputSchema: z.object({
        caseId: z.string().min(1).describe("A directory name under evals/cases, such as 01-clamp-decrement."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ caseId }) => json(await replayCase(caseId)),
  );

  server.registerTool(
    "start_run",
    {
      description:
        "Run an issue against the committed HEAD of a local git checkout: plan, implement, verify, review, write, " +
        "then the gate. A gate pass commits the change to a new local branch thin-pr/local-<n>. Nothing is pushed " +
        "and the checkout's working tree is not touched. The model mode comes from the server's THIN_PR_MODEL " +
        "(replay by default, with THIN_PR_CASSETTE). Returns the status, the branch, the run report and the RunRecord, " +
        "which is also written to THIN_PR_RUNS_DIR when it is set.",
      inputSchema: z.object({
        repo: z.string().refine(isAbsolute, "must be an absolute path").describe("Absolute path of the git checkout to change."),
        issue: z.string().min(1).describe("The issue text. The first line is the title, the rest is the body."),
      }),
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ repo, issue }) => {
      const result = await runLocal({
        repo,
        issue,
        runsDir: options.runsDir,
        model: () => createAnthropicClient(clientOptionsFromEnv()),
      });
      return json(result);
    },
  );

  return server;
}

function json(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}
