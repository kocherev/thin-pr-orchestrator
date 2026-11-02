import type Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { PricedModel } from "./pricing.js";
import { IMPLEMENTER_SYSTEM } from "./prompts.js";
import { cachedSystem, fallbackFor, issueBlock, RefusalError, TruncatedOutputError, type Effort } from "./structured.js";
import { SPECIALIST_HEADER } from "./transport.js";
import type { Workspace } from "./workspace.js";

const SPECIALIST = "implementer";

/** Each turn may write a whole file, and adaptive thinking spends from the same budget. */
const MAX_TOKENS = 32_000;

export const MAX_TURNS = 25;

export class TurnLimitError extends Error {
  readonly maxTurns: number;

  constructor(maxTurns: number) {
    super(`implementer still wanted tools after ${maxTurns} turns`);
    this.name = "TurnLimitError";
    this.maxTurns = maxTurns;
  }
}

export type ImplementRequest = {
  readonly model: PricedModel;
  readonly effort: Effort;
  readonly issue: string;
  /** The plan, and the loop feedback when there is any. */
  readonly input: string;
  readonly workspace: Workspace;
  readonly maxTurns?: number;
};

/** Runs the tool loop until the model stops asking for tools. Returns the model's closing summary. */
export async function runImplementer(client: Anthropic, request: ImplementRequest): Promise<string> {
  const maxTurns = request.maxTurns ?? MAX_TURNS;
  const runner = client.beta.messages.toolRunner(
    {
      ...fallbackFor(request.model),
      model: request.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: request.effort },
      system: cachedSystem(IMPLEMENTER_SYSTEM),
      tools: workspaceTools(request.workspace),
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: [issueBlock(request.issue), { type: "text", text: request.input }] }],
    },
    { headers: { [SPECIALIST_HEADER]: SPECIALIST } },
  );
  let turns = 0;
  let last: Anthropic.Beta.Messages.BetaMessage | null = null;
  // The runner runs a turn's tools only when the loop asks for the next message, so a throw here stops them.
  for await (const message of runner) {
    turns += 1;
    last = message;
    if (message.stop_reason === "refusal") {
      throw new RefusalError(SPECIALIST, message.model, message.stop_details?.category ?? null);
    }
    if (message.stop_reason === "max_tokens" && message.content.some((block) => block.type === "tool_use")) {
      throw new TruncatedOutputError(SPECIALIST, MAX_TOKENS);
    }
    if (message.stop_reason === "tool_use" && turns >= maxTurns) {
      throw new TurnLimitError(maxTurns);
    }
  }
  const summary = (last?.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
  return summary.length > 0 ? summary : "The implementer left no summary.";
}

function workspaceTools(workspace: Workspace) {
  const tools = [
    betaZodTool({
      name: "list_files",
      description: "List every file in the repository, one path per line.",
      inputSchema: z.object({}).strict(),
      run: async () => (await workspace.listFiles()).join("\n"),
    }),
    betaZodTool({
      name: "read_file",
      description: "Read one file. The path is relative to the repository root.",
      inputSchema: z.object({ path: z.string() }).strict(),
      run: async ({ path }) => (await workspace.readFile(path)) ?? `${path} does not exist.`,
    }),
    betaZodTool({
      name: "search",
      description: "Search every file for a regular expression, or a fixed string when it is not one. Returns path:line: text.",
      inputSchema: z.object({ pattern: z.string() }).strict(),
      run: async ({ pattern }) => {
        const hits = await workspace.search(pattern);
        return hits.length === 0 ? "No matches." : hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`).join("\n");
      },
    }),
    betaZodTool({
      name: "replace",
      description: "Replace old_text with new_text in one existing file. old_text must match exactly once.",
      inputSchema: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }).strict(),
      run: async ({ path, old_text, new_text }) => {
        await workspace.replace(path, old_text, new_text);
        return `Replaced the text in ${path}.`;
      },
    }),
    betaZodTool({
      name: "create_file",
      description: "Create a new file. Fails when the file exists or the path is not allowed.",
      inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
      run: async ({ path, content }) => {
        await workspace.createFile(path, content);
        return `Created ${path}.`;
      },
    }),
    betaZodTool({
      name: "run_check",
      description: "Run one of the repository's configured checks. Returns the exit code and the end of the log.",
      inputSchema: z.object({ name: z.enum(["typecheck", "test"]) }).strict(),
      run: async ({ name }) => {
        const result = await workspace.runCheck(name);
        return `${result.name} exited ${result.exitCode}: ${result.command}\n${result.logTail}`;
      },
    }),
  ];
  return tools.map((tool) => ({ ...tool, strict: true }));
}
