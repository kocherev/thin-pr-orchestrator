import type Anthropic from "@anthropic-ai/sdk";
import type { Middleware, MiddlewareContext } from "@anthropic-ai/sdk";
import type { Usage } from "@thin-pr/core";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { costOf, pricedModel, type BilledUsage, type PricedModel } from "./pricing.js";

/** Names the specialist behind a request. The transport reads it and strips it before anything is sent. */
export const SPECIALIST_HEADER = "x-thin-pr-specialist";

export type TransportOptions =
  | { readonly mode: "live"; readonly spendLimitUsd: number }
  | { readonly mode: "record" | "replay"; readonly cassettePath: string; readonly spendLimitUsd: number };

const cassetteEntry = z
  .object({
    // "live" came from the API. "converted" was rebuilt from an older recording, with estimated usage.
    source: z.enum(["live", "converted"]),
    specialist: z.string().min(1),
    model: z.string().min(1),
    durationMs: z.number().nonnegative(),
    // The conversation sent. System prompts and tool schemas live in the code.
    request: z.object({ messages: z.json() }).strict(),
    // A JSON body is stored parsed. A streamed body is stored as the raw event stream text.
    response: z.object({ contentType: z.string(), body: z.json() }).strict(),
  })
  .strict();

export type CassetteEntry = z.infer<typeof cassetteEntry>;

const messageRequest = z.looseObject({ model: z.string(), max_tokens: z.number(), messages: z.json() });

export class CassetteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CassetteError";
  }
}

export class SpendLimitError extends Error {
  readonly limitUsd: number;
  readonly spentUsd: number;

  constructor(limitUsd: number, spentUsd: number) {
    super(`model spend would pass the ${limitUsd} USD limit (${spentUsd.toFixed(6)} USD spent)`);
    this.name = "SpendLimitError";
    this.limitUsd = limitUsd;
    this.spentUsd = spentUsd;
  }
}

/** Running spend and one `Usage` record per model call, in call order. */
export class SpendMeter {
  private spent = 0;
  private readonly calls: Usage[] = [];

  constructor(readonly limitUsd: number) {}

  get spentUsd(): number {
    return this.spent;
  }

  get usage(): readonly Usage[] {
    return [...this.calls];
  }

  /** Input size is unknown before the call, so this prices the largest output the request allows. */
  assertRoomFor(model: PricedModel, maxTokens: number): void {
    const worstCase = costOf(model, {
      input_tokens: 0,
      output_tokens: maxTokens,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    });
    if (this.spent + worstCase > this.limitUsd) {
      throw new SpendLimitError(this.limitUsd, this.spent);
    }
  }

  record(model: PricedModel, usage: BilledUsage, durationMs: number): void {
    const costUsd = costOf(model, usage);
    this.spent += costUsd;
    this.calls.push({
      model,
      // Usage has no cache-write field, so written tokens count as input.
      inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      costUsd,
      durationMs,
    });
  }
}

/**
 * SDK middleware that replays, records, or passes model calls through, and meters each one.
 * Middleware errors reach the caller as they are; a custom `fetch` error would be retried and wrapped.
 */
export function createTransport(options: TransportOptions): { middleware: Middleware; meter: SpendMeter } {
  const meter = new SpendMeter(options.spendLimitUsd);
  const play = options.mode === "replay" ? player(options.cassettePath) : null;
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

    if (play) {
      const entry = play(specialist, model);
      const { contentType, body: recorded } = entry.response;
      const text = typeof recorded === "string" ? recorded : JSON.stringify(recorded);
      const response = new Response(text, { status: 200, headers: { "content-type": contentType } });
      meter.record(model, await billedUsage(response, ctx), entry.durationMs);
      return response;
    }

    meter.assertRoomFor(model, sent.max_tokens);
    const started = Date.now();
    const upstream = await next({ ...request, headers });
    if (!upstream.ok) {
      return upstream;
    }
    // Buffered so the body can be metered and recorded. A streamed reply reaches the caller once it ends.
    const text = await upstream.text();
    const durationMs = Date.now() - started;
    const response = new Response(text, upstream);
    meter.record(model, await billedUsage(response, ctx), durationMs);
    if (write) {
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      const stored = contentType.includes("json") ? z.json().parse(JSON.parse(text)) : text;
      const entry = { source: "live", specialist, model, durationMs, request: { messages: sent.messages } } as const;
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

/** Hands out recorded calls in order, per specialist, and checks each one asks for the recorded model. */
function player(path: string): (specialist: string, model: string) => CassetteEntry {
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

  return (specialist, model) => {
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
