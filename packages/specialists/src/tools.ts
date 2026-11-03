import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import {
  cachedSystem,
  fallbackFor,
  issueBlock,
  parseReply,
  RefusalError,
  TruncatedOutputError,
  type StructuredRequest,
} from "./structured.js";
import { SPECIALIST_HEADER } from "./transport.js";
import type { Workspace } from "./workspace.js";

const READ_MAX_TOKENS = 16_000;

/** Enough for a few rounds of parallel reads and searches before the reply. */
const READ_MAX_TURNS = 8;

/**
 * A structured-output call that may first read the workspace with `read_file` and `search`. The API allows tools and
 * `output_config.format` in one request, and the reply that ends the loop follows the schema.
 */
export async function structuredWithReads<T>(
  client: Anthropic,
  request: StructuredRequest<T> & { readonly workspace: Workspace },
): Promise<T> {
  const runner = client.beta.messages.toolRunner(
    {
      ...fallbackFor(request.model),
      model: request.model,
      max_tokens: READ_MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: request.effort, format: betaZodOutputFormat(request.schema) },
      system: cachedSystem(request.system),
      tools: readTools(request.workspace),
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: [issueBlock(request.issue), { type: "text", text: request.input }] }],
    },
    { headers: { [SPECIALIST_HEADER]: request.specialist } },
  );
  const last = await runToolLoop(runner, { specialist: request.specialist, maxTurns: READ_MAX_TURNS, maxTokens: READ_MAX_TOKENS });
  if (!last || last.stop_reason === "max_tokens") {
    throw new TruncatedOutputError(request.specialist, READ_MAX_TOKENS);
  }
  return parseReply(request, last);
}

export class TurnLimitError extends Error {
  readonly specialist: string;
  readonly maxTurns: number;

  constructor(specialist: string, maxTurns: number) {
    super(`${specialist} still wanted tools after ${maxTurns} turns`);
    this.name = "TurnLimitError";
    this.specialist = specialist;
    this.maxTurns = maxTurns;
  }
}

/**
 * Drives a tool runner until the model stops asking for tools and returns the last message. A refusal, a tool call
 * cut off at `maxTokens`, or a request for tools on turn `maxTurns` throws. The runner runs a turn's tools only when
 * the loop asks for the next message, so a throw here stops them.
 */
export async function runToolLoop(
  runner: AsyncIterable<Anthropic.Beta.Messages.BetaMessage>,
  limits: { readonly specialist: string; readonly maxTurns: number; readonly maxTokens: number },
): Promise<Anthropic.Beta.Messages.BetaMessage | null> {
  let turns = 0;
  let last: Anthropic.Beta.Messages.BetaMessage | null = null;
  for await (const message of runner) {
    turns += 1;
    last = message;
    if (message.stop_reason === "refusal") {
      throw new RefusalError(limits.specialist, message.model, message.stop_details?.category ?? null);
    }
    if (message.stop_reason === "max_tokens" && message.content.some((block) => block.type === "tool_use")) {
      throw new TruncatedOutputError(limits.specialist, limits.maxTokens);
    }
    if (message.stop_reason === "tool_use" && turns >= limits.maxTurns) {
      throw new TurnLimitError(limits.specialist, limits.maxTurns);
    }
  }
  return last;
}

/** The tools that only read the workspace. */
export function readTools(workspace: Workspace) {
  return strict([
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
  ]);
}

/** Every workspace tool: list, read, search, edit, create, and run a check. There is no shell. */
export function workspaceTools(workspace: Workspace) {
  return [
    ...strict([
      betaZodTool({
        name: "list_files",
        description: "List every file in the repository, one path per line.",
        inputSchema: z.object({}).strict(),
        run: async () => (await workspace.listFiles()).join("\n"),
      }),
    ]),
    ...readTools(workspace),
    ...strict([
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
    ]),
  ];
}

function strict<T extends object>(tools: readonly T[]): (T & { strict: true })[] {
  return tools.map((tool) => ({ ...tool, strict: true }));
}
