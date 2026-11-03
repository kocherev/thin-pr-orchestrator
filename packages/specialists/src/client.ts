import Anthropic from "@anthropic-ai/sdk";
import { createTransport, type SpendMeter } from "./transport.js";

const DEFAULT_SPEND_LIMIT_USD = 25;

// One non-streaming call at high effort can run for minutes. An explicit timeout also lifts the
// SDK's refusal of large non-streaming max_tokens, so keep those requests under the timeout.
const TIMEOUT_MS = 10 * 60 * 1000;
// Live calls retry 408, 409, 429 and 5xx with backoff. A replayed call has nothing transient to retry.
const LIVE_MAX_RETRIES = 2;

export type AnthropicClientOptions = (
  | { readonly mode: "live" }
  | { readonly mode: "record" | "replay"; readonly cassettePath: string }
) & {
  readonly apiKey?: string;
  readonly spendLimitUsd?: number;
  /** Upstream fetch for live and record calls. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
};

/** The client a run's model steps share, and the meter that prices its calls. */
export type ModelSession = { readonly client: Anthropic; readonly meter: SpendMeter };

export function createAnthropicClient(
  options: AnthropicClientOptions,
  env: Record<string, string | undefined> = process.env,
): ModelSession {
  const spendLimitUsd = options.spendLimitUsd ?? spendLimitFrom(env);
  const { middleware, meter } = createTransport(
    options.mode === "live"
      ? { mode: "live", spendLimitUsd }
      : { mode: options.mode, cassettePath: options.cassettePath, spendLimitUsd },
  );
  const client = new Anthropic({
    // Replay never reaches the network, but the SDK will not build a request without a credential.
    apiKey: options.mode === "replay" ? "replay" : requireKey(options.apiKey ?? env.ANTHROPIC_API_KEY),
    middleware: [middleware],
    fetch: options.fetch,
    timeout: TIMEOUT_MS,
    maxRetries: options.mode === "replay" ? 0 : LIVE_MAX_RETRIES,
    // The SDK opens one span per request and per tool run. Set in code, this option also ignores the
    // ANTHROPIC_OPEN_TELEMETRY_* variables, so no environment can add prompts or file contents to a span.
    openTelemetry: { traces: { contentMode: "metadata_only" } },
  });
  return { client, meter };
}

/** `THIN_PR_MODEL` picks the mode, replay by default. Record and replay read the cassette from `THIN_PR_CASSETTE`. */
export function clientOptionsFromEnv(env: Record<string, string | undefined> = process.env): AnthropicClientOptions {
  const mode = env.THIN_PR_MODEL || "replay";
  if (mode === "live") {
    return { mode };
  }
  if (mode !== "record" && mode !== "replay") {
    throw new Error("THIN_PR_MODEL must be live, record or replay");
  }
  const cassettePath = env.THIN_PR_CASSETTE;
  if (!cassettePath) {
    throw new Error(`THIN_PR_CASSETTE is required when THIN_PR_MODEL is ${mode}`);
  }
  return { mode, cassettePath };
}

export function requireKey(key: string | undefined): string {
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY is missing");
  }
  return key;
}

/** `THIN_PR_SPEND_LIMIT_USD`, or 25 when it is unset. */
export function spendLimitFrom(env: Record<string, string | undefined>): number {
  const raw = env.THIN_PR_SPEND_LIMIT_USD;
  if (raw === undefined || raw === "") {
    return DEFAULT_SPEND_LIMIT_USD;
  }
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("THIN_PR_SPEND_LIMIT_USD must be a positive number");
  }
  return limit;
}
