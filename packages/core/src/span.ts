import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import type { Usage } from "./types.js";

const tracer = trace.getTracer("@thin-pr/core");

export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
      }
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : "step failed",
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * The model usage of a step pass or a run. Input tokens include cache reads, as `gen_ai.usage.input_tokens` does
 * on each request span. The `thin_pr.usage.*` names keep these totals out of a backend's `gen_ai.usage` sums.
 */
export function usageAttributes(usage: readonly Usage[]): Attributes {
  const sum = (pick: (call: Usage) => number) => usage.reduce((total, call) => total + pick(call), 0);
  return {
    "thin_pr.usage.requests": usage.length,
    "thin_pr.usage.input_tokens": sum((call) => call.inputTokens + call.cacheReadTokens),
    "thin_pr.usage.output_tokens": sum((call) => call.outputTokens),
    "thin_pr.usage.cache_read_tokens": sum((call) => call.cacheReadTokens),
    "thin_pr.usage.cost_usd": sum((call) => call.costUsd),
  };
}
