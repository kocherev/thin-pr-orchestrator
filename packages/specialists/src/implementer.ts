import type Anthropic from "@anthropic-ai/sdk";
import type { PricedModel } from "./pricing.js";
import { implementerSystem, type Budget } from "./prompts.js";
import { cachedSystem, fallbackFor, issueBlock, type Effort } from "./structured.js";
import { CACHE_CONVERSATION, runToolLoop, workspaceTools } from "./tools.js";
import { SPECIALIST_HEADER } from "./transport.js";
import type { Workspace } from "./workspace.js";

const SPECIALIST = "implementer";

/** Each turn may write a whole file, and adaptive thinking spends from the same budget. */
const MAX_TOKENS = 32_000;

/**
 * The feature budget allows 12 files. Reading and editing each one takes two or three turns, and running the checks
 * and fixing what they report takes several more, so 25 turns ran out before a change that size could finish.
 * The run's spend_usd still caps what a long loop costs.
 */
export const MAX_TURNS = 60;

const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

/**
 * Server-side clearing of old tool results. Per platform.claude.com/docs/en/build-with-claude/context-editing the API
 * applies it before the prompt reaches the model and the client keeps the full history, so the tool runner's message
 * list needs no change. Clearing invalidates the cached prefix from that point, so each pass clears at least 20,000
 * tokens. The 6 most recent tool calls stay, which keeps the file just read and the last check log.
 */
const CLEAR_OLD_TOOL_RESULTS: Anthropic.Beta.Messages.BetaContextManagementConfig = {
  edits: [
    {
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: 60_000 },
      keep: { type: "tool_uses", value: 6 },
      clear_at_least: { type: "input_tokens", value: 20_000 },
    },
  ],
};

export type ImplementRequest = {
  readonly model: PricedModel;
  readonly effort: Effort;
  readonly issue: string;
  /** The plan, and the loop feedback when there is any. */
  readonly input: string;
  readonly workspace: Workspace;
  readonly budget: Budget;
  readonly maxTurns?: number;
};

/** Runs the tool loop until the model stops asking for tools. Returns the model's closing summary. */
export async function runImplementer(client: Anthropic, request: ImplementRequest): Promise<string> {
  const fallback = fallbackFor(request.model);
  const runner = client.beta.messages.toolRunner(
    {
      ...fallback,
      betas: [...(fallback.betas ?? []), CONTEXT_MANAGEMENT_BETA],
      context_management: CLEAR_OLD_TOOL_RESULTS,
      cache_control: CACHE_CONVERSATION,
      model: request.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: request.effort },
      system: cachedSystem(implementerSystem(request.budget)),
      tools: workspaceTools(request.workspace),
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: [issueBlock(request.issue), { type: "text", text: request.input }] }],
    },
    { headers: { [SPECIALIST_HEADER]: SPECIALIST } },
  );
  const last = await runToolLoop(runner, { specialist: SPECIALIST, maxTurns: request.maxTurns ?? MAX_TURNS, maxTokens: MAX_TOKENS });
  const summary = (last?.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
  return summary.length > 0 ? summary : "The implementer left no summary.";
}
