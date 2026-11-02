import type Anthropic from "@anthropic-ai/sdk";

type Rates = { readonly input: number; readonly output: number; readonly cacheRead: number };

/** Rates that apply once the whole prompt is longer than `abovePromptTokens`. Tiers are in ascending order. */
type Tier = { readonly abovePromptTokens: number; readonly usdPerMillion: Rates };

// USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing as of 2026-11.
const PRICES = {
  "claude-opus-5-5": [{ abovePromptTokens: 0, usdPerMillion: { input: 4, output: 20, cacheRead: 0.2 } }],
  "claude-sonnet-5-5": [{ abovePromptTokens: 0, usdPerMillion: { input: 2, output: 10, cacheRead: 0.2 } }],
  "claude-haiku-5-5": [
    { abovePromptTokens: 0, usdPerMillion: { input: 0.1, output: 0.5, cacheRead: 0.01 } },
    { abovePromptTokens: 100_000, usdPerMillion: { input: 0.5, output: 2.5, cacheRead: 0.05 } },
  ],
  "claude-fable-5-1": [{ abovePromptTokens: 0, usdPerMillion: { input: 10, output: 50, cacheRead: 0.25 } }],
} as const satisfies Record<string, readonly [Tier, ...Tier[]]>;

// A 5-minute cache write costs 1.25 times the input rate. Requests here use only that TTL.
const CACHE_WRITE_MULTIPLIER = 1.25;

export type PricedModel = keyof typeof PRICES;

export type BilledUsage = Pick<
  Anthropic.Messages.Usage,
  "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens"
>;

export function isPricedModel(model: string): model is PricedModel {
  return Object.hasOwn(PRICES, model);
}

export function costOf(model: PricedModel, usage: BilledUsage): number {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const promptTokens = usage.input_tokens + cacheRead + cacheWrite;
  const tiers: readonly [Tier, ...Tier[]] = PRICES[model];
  let rates = tiers[0].usdPerMillion;
  for (const tier of tiers) {
    if (promptTokens > tier.abovePromptTokens) rates = tier.usdPerMillion;
  }
  const usd =
    usage.input_tokens * rates.input +
    cacheWrite * rates.input * CACHE_WRITE_MULTIPLIER +
    cacheRead * rates.cacheRead +
    usage.output_tokens * rates.output;
  return usd / 1_000_000;
}
