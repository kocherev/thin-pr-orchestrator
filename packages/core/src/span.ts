import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";

const tracer = trace.getTracer("@thin-pr/core");

export async function withSpan<T>(
  name: string,
  attributes: Readonly<Record<string, string>>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }
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
