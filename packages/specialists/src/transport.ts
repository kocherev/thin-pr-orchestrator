import type Anthropic from "@anthropic-ai/sdk";
import type { Middleware, MiddlewareContext } from "@anthropic-ai/sdk";
import { trace } from "@opentelemetry/api";
import type { Usage } from "@thin-pr/core";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { costOf, pricedModel, type BilledUsage, type PricedModel } from "./pricing.js";
import { stableText } from "./stable.js";

/** Names the specialist behind a request. The transport reads it and strips it before anything is sent. */
export const SPECIALIST_HEADER = "x-thin-pr-specialist";

const ATTR_SPECIALIST = "thin_pr.specialist";
const ATTR_COST_USD = "thin_pr.cost_usd";

export type TransportOptions =
  | { readonly mode: "live"; readonly spendLimitUsd: number }
  | {
      readonly mode: "record" | "replay";
      readonly cassettePath: string;
      readonly spendLimitUsd: number;
      /** Replay only. False serves the recorded replies in order without comparing request hashes. */
      readonly checkRequests?: boolean;
    };

const cassetteEntry = z
  .object({
    // "live" came from the API. "converted" was rebuilt from an older recording and "scripted" was written by hand
    // through the scripted upstream. Both carry estimated usage.
    source: z.enum(["live", "converted", "scripted"]),
    recordedAt: z.iso.datetime().optional(),
    specialist: z.string().min(1),
    model: z.string().min(1),
    durationMs: z.number().nonnegative(),
    // The conversation sent. System prompts and tool schemas live in the code.
    request: z.object({ messages: z.json() }).strict(),
    // `requestHash` of the whole request. Replay fails when the request it gets hashes differently.
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    // A JSON body is stored parsed. A streamed body is stored as the raw event stream text.
    response: z.object({ contentType: z.string(), body: z.json() }).strict(),
  })
  .strict();

export type CassetteEntry = z.infer<typeof cassetteEntry>;

const messageRequest = z.looseObject({ model: z.string(), max_tokens: z.number(), messages: z.json() });

/** What a request asks the model. Headers, betas, limits and fallbacks change how it is served, not what it asks. */
const HASHED_FIELDS = ["model", "system", "messages", "tools", "output_config"] as const;

/**
 * SHA-256 of a request's model, system prompt, messages, tools and output config. Keys are sorted, and every string
 * goes through `stableText`, because tool results carry check logs with scratch paths and timings.
 */
export function requestHash(body: Readonly<Record<string, unknown>>): string {
  const asked = Object.fromEntries(HASHED_FIELDS.map((field) => [field, body[field] ?? null]));  return createHash("sha256").update(canonical(asked)).digest("hex");
}

function canonical(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(stableText(value));
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class CassetteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CassetteError";
  }
}

/** `session` is the limit for the whole client, `THIN_PR_SPEND_LIMIT_USD`. `run` is one run's `spend_usd`. */
export class SpendLimitError extends Error {
  readonly scope: "session" | "run";
  readonly limitUsd: number;
  readonly spentUsd: number;

  constructor(scope: "session" | "run", limitUsd: number, spentUsd: number) {
    super(
      scope === "session"
        ? `model spend would pass the ${limitUsd} USD limit (${spentUsd.toFixed(6)} USD spent)`
        : `the next model call could pass the run's spend_usd of ${limitUsd} USD (${spentUsd.toFixed(6)} USD spent)`,
    );
    this.name = "SpendLimitError";
    this.scope = scope;
    this.limitUsd = limitUsd;
    this.spentUsd = spentUsd;
  }
}

/** Running spend and one `Usage` record per model call, in call order. */
export class SpendMeter {
  private spent = 0;
  private readonly calls: Usage[] = [];
  private run: { readonly startUsd: number; readonly limitUsd: number } | null = null;
  /** Per specialist, the input and output tokens of its last call. */
  private readonly lastTurnTokens = new Map<string, number>();

  constructor(readonly limitUsd: number) {}

  get spentUsd(): number {
    return this.spent;
  }

  get usage(): readonly Usage[] {
    return [...this.calls];
  }

  /** Caps what the calls from now on may spend, under the session limit. A run sets its `spend_usd` here. */
  limitRun(limitUsd: number): void {
    this.run = { startUsd: this.spent, limitUsd };
  }

  /**
   * Prices the largest output the request allows, plus an input estimate: the specialist's previous request and its
   * reply, all at the uncached rate. A tool loop sends both again on the next turn, so a late turn's input counts.
   * Tool results added since are not known yet. A specialist's first call counts no input.
   */
  assertRoomFor(model: PricedModel, maxTokens: number, specialist: string): void {
    const worstCase = costOf(model, {
      input_tokens: this.lastTurnTokens.get(specialist) ?? 0,
      output_tokens: maxTokens,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    });
    if (this.spent + worstCase > this.limitUsd) {
      throw new SpendLimitError("session", this.limitUsd, this.spent);
    }
    const runSpent = this.spent - (this.run?.startUsd ?? 0);
    if (this.run && runSpent + worstCase > this.run.limitUsd) {
      throw new SpendLimitError("run", this.run.limitUsd, runSpent);
    }
  }

  record(model: PricedModel, usage: BilledUsage, durationMs: number, specialist: string): Usage {
    const costUsd = costOf(model, usage);
    this.spent += costUsd;
    const input = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    this.lastTurnTokens.set(specialist, input + usage.output_tokens);
    const call = {
      model,
      // Usage has no cache-write field, so written tokens count as input.
      inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      costUsd,
      durationMs,
    };
    this.calls.push(call);
    return call;
  }
}

/**
 * SDK middleware that replays, records, or passes model calls through, and meters each one.
 * Middleware errors reach the caller as they are; a custom `fetch` error would be retried and wrapped.
 */
export function createTransport(options: TransportOptions): { middleware: Middleware; meter: SpendMeter } {
  const meter = new SpendMeter(options.spendLimitUsd);
  const play = options.mode === "replay" ? player(options.cassettePath, options.checkRequests ?? true) : null;
  const write = options.mode === "record" ? recorder(options.cassettePath) : null;

  const middleware: Middleware = async (request, next, ctx) => {
    const headers = new Headers(request.headers);
    const specialist = headers.get(SPECIALIST_HEADER);
    headers.delete(SPECIALIST_HEADER);
    if (!specialist) {
      throw new Error(`model request has no ${SPECIALIST_HEADER} header`);
    }
    if (typeof request.body !== "string") {
      throw new Error("model request body is not JSON text");
    }
    const sent = messageRequest.parse(JSON.parse(request.body));
    const model = pricedModel(sent.model);
    const hash = requestHash(sent);
    // The SDK runs middleware inside its `anthropic.messages.create` span, which has the GenAI attributes.
    // This adds what only the transport knows.
    const span = trace.getActiveSpan();
    span?.setAttribute(ATTR_SPECIALIST, specialist);
    const price = async (response: Response, durationMs: number) => {
      const call = meter.record(model, await billedUsage(response, ctx), durationMs, specialist);
      span?.setAttribute(ATTR_COST_USD, call.costUsd);
    };

    if (play) {
      const entry = play(specialist, model, hash);
      const { contentType, body: recorded } = entry.response;
      const text = typeof recorded === "string" ? recorded : JSON.stringify(recorded);
      const response = new Response(text, { status: 200, headers: { "content-type": contentType } });
      await price(response, entry.durationMs);
      return response;
    }

    meter.assertRoomFor(model, sent.max_tokens, specialist);
    const started = Date.now();
    const upstream = await next({ ...request, headers });
    if (!upstream.ok) {
      return upstream;
    }
    // Buffered so the body can be metered and recorded. A streamed reply reaches the caller once it ends.
    const text = await upstream.text();
    const durationMs = Date.now() - started;
    const response = new Response(text, upstream);
    await price(response, durationMs);
    if (write) {
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      const stored = contentType.includes("json") ? z.json().parse(JSON.parse(text)) : text;
      const recordedAt = new Date().toISOString();
      const request = { messages: sent.messages };
      const entry = { source: "live", recordedAt, specialist, model, durationMs, request, requestHash: hash } as const;
      write({ ...entry, response: { contentType, body: stored } });
    }
    return response;
  };

  return { middleware, meter };
}

async function billedUsage(response: Response, ctx: MiddlewareContext): Promise<BilledUsage> {
  if (!ctx.options?.stream) {
    return (await ctx.parse<Pick<Anthropic.Message, "usage">>(response)).usage;
  }
  let usage: BilledUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
  };
  for await (const event of await ctx.parse<AsyncIterable<Anthropic.RawMessageStreamEvent>>(response)) {
    if (event.type === "message_start") {
      usage = event.message.usage;
    } else if (event.type === "message_delta") {
      usage = {
        input_tokens: event.usage.input_tokens ?? usage.input_tokens,
        output_tokens: event.usage.output_tokens,
        cache_read_input_tokens: event.usage.cache_read_input_tokens ?? usage.cache_read_input_tokens,
        cache_creation_input_tokens: event.usage.cache_creation_input_tokens ?? usage.cache_creation_input_tokens,
      };
    }
  }
  return usage;
}

/** Hands out recorded calls in order, per specialist, and checks each one is the request that was recorded. */
function player(path: string, checkRequests: boolean): (specialist: string, model: string, hash: string) => CassetteEntry {
  const queues = new Map<string, CassetteEntry[]>();
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const entry = parseLine(line);
    if (!entry) {
      throw new CassetteError(`cassette ${path} line ${index + 1} is not a recorded call`);
    }
    queues.set(entry.specialist, [...(queues.get(entry.specialist) ?? []), entry]);
  }
  const played = new Map<string, number>();

  return (specialist, model, hash) => {
    const call = (played.get(specialist) ?? 0) + 1;
    played.set(specialist, call);
    const entry = queues.get(specialist)?.[call - 1];
    if (!entry) {
      const recorded = queues.get(specialist)?.length ?? 0;
      throw new CassetteError(`cassette ${path} has ${recorded} ${specialist} calls; call ${call} was requested`);
    }
    if (entry.model !== model) {
      throw new CassetteError(
        `cassette ${path}: ${specialist} call ${call} was recorded with ${entry.model}, the request asks for ${model}`,
      );
    }
    if (checkRequests && entry.requestHash !== hash) {
      throw new CassetteError(
        `cassette ${path}: request drifted from the cassette at ${specialist} call ${call}; re-record with pnpm eval:record`,
      );
    }
    return entry;
  };
}

function parseLine(line: string): CassetteEntry | null {
  try {
    return cassetteEntry.parse(JSON.parse(line));
  } catch {
    return null;
  }
}

/** Starts the cassette empty, then appends one JSON line per call. */
function recorder(path: string): (entry: CassetteEntry) => void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  return (entry) => appendFileSync(path, `${JSON.stringify(entry)}\n`);
}
