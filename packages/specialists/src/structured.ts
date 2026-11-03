import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { SpecialistSchemaError } from "./contract.js";
import type { PricedModel } from "./pricing.js";
import { SPECIALIST_HEADER } from "./transport.js";

export type Effort = NonNullable<Anthropic.Beta.Messages.BetaOutputConfig["effort"]>;

export type RefusalCategory = Anthropic.Beta.Messages.BetaRefusalStopDetails["category"];

export class RefusalError extends Error {
  readonly specialist: string;
  readonly model: string;
  readonly category: RefusalCategory;

  constructor(specialist: string, model: string, category: RefusalCategory) {
    super(`${specialist} request was refused by ${model} (category: ${category ?? "none"})`);
    this.name = "RefusalError";
    this.specialist = specialist;
    this.model = model;
    this.category = category;
  }
}

export class TruncatedOutputError extends Error {
  readonly specialist: string;
  readonly maxTokens: number;

  constructor(specialist: string, maxTokens: number) {
    super(`${specialist} reply was cut off at max_tokens ${maxTokens}`);
    this.name = "TruncatedOutputError";
    this.specialist = specialist;
    this.maxTokens = maxTokens;
  }
}

export type StructuredRequest<T> = {
  readonly specialist: string;
  readonly model: PricedModel;
  readonly effort: Effort;
  readonly system: string;
  /** Untrusted issue text. It goes in its own content block inside <issue> tags. */
  readonly issue: string;
  readonly input: string;
  readonly schema: z.ZodType<T>;
};

// Adaptive thinking spends from max_tokens too. A cut-off reply is retried once with twice the room.
const MAX_TOKENS = [16_000, 32_000] as const;

// The "default" fallback form is documented for Opus 5.5 and Sonnet 5.5. Haiku 5.5 has no server-side fallback.
const FALLBACK_MODELS: ReadonlySet<PricedModel> = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The server-side fallback opt-in for a model that has one, or nothing. */
export function fallbackFor(model: PricedModel): { betas?: string[]; fallbacks?: "default" } {
  return FALLBACK_MODELS.has(model) ? { betas: [FALLBACK_BETA], fallbacks: "default" } : {};
}

/** A system prompt as one cached block. */
export function cachedSystem(text: string): Anthropic.Beta.Messages.BetaTextBlockParam[] {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

/** The untrusted issue text in its own block, inside <issue> tags. */
export function issueBlock(issue: string): Anthropic.Beta.Messages.BetaTextBlockParam {
  return { type: "text", text: `<issue>\n${issue}\n</issue>` };
}

/** One structured-output call. Returns the reply parsed by `schema`. */
export async function structured<T>(client: Anthropic, request: StructuredRequest<T>): Promise<T> {
  for (const maxTokens of MAX_TOKENS) {
    const message = await client.beta.messages.create(
      {
        ...fallbackFor(request.model),
        model: request.model,
        max_tokens: maxTokens,
        thinking: { type: "adaptive" },
        output_config: { effort: request.effort, format: betaZodOutputFormat(request.schema) },
        system: cachedSystem(request.system),
        messages: [{ role: "user", content: [issueBlock(request.issue), { type: "text", text: request.input }] }],
      },
      { headers: { [SPECIALIST_HEADER]: request.specialist } },
    );
    if (message.stop_reason === "refusal") {
      throw new RefusalError(request.specialist, message.model, message.stop_details?.category ?? null);
    }
    if (message.stop_reason !== "max_tokens") {
      return parseReply(request, message);
    }
  }
  throw new TruncatedOutputError(request.specialist, MAX_TOKENS[1]);
}

/** The reply text parsed as JSON and checked against `request.schema`. */
export function parseReply<T>(request: Pick<StructuredRequest<T>, "specialist" | "schema">, message: Anthropic.Beta.Messages.BetaMessage): T {
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SpecialistSchemaError(request.specialist, "output", "(root)", "reply is not JSON");
  }
  const parsed = request.schema.safeParse(json);
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  throw new SpecialistSchemaError(request.specialist, "output", issue?.path.join(".") || "(root)", issue?.message ?? "invalid");
}
