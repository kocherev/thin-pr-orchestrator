import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { z } from "zod";

const TRACE_SERVICE_NAME = "thin-pr-orchestrator";

const spansSchema = z.object({
  resourceSpans: z.array(
    z.object({ scopeSpans: z.array(z.object({ spans: z.array(z.object({ name: z.string().min(1) })) })) }),
  ),
});

type TraceSession = {
  /** Ends the trace. Returns the OTLP JSON document, or null when the spans went to an OTLP endpoint. */
  stop(): Promise<string | null>;
};

/** True when the standard OTLP variables name an endpoint. The SDK then reads the rest of them itself. */
function otlpEndpointSet(env: Record<string, string | undefined>): boolean {
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}

export function startTrace(env: Record<string, string | undefined> = process.env): TraceSession {
  // Traces are the signal. Metrics and logs would wait on a collector that may not be running.
  process.env.OTEL_METRICS_EXPORTER = "none";
  process.env.OTEL_LOGS_EXPORTER = "none";

  const memory = otlpEndpointSet(env) ? null : new InMemorySpanExporter();
  const processor = memory ? new SimpleSpanProcessor({ exporter: memory }) : null;
  const sdk = new NodeSDK({
    // Host and process detectors would put the machine name into the trace.
    autoDetectResources: false,
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: TRACE_SERVICE_NAME }),
    // Without span processors, the SDK builds the OTLP exporter from OTEL_EXPORTER_OTLP_* (protocol, headers).
    spanProcessors: processor ? [processor] : undefined,
  });
  sdk.start();

  return {
    async stop() {
      if (!memory || !processor) {
        await sdk.shutdown();
        return null;
      }
      await processor.forceFlush();
      // Shutting down clears the exporter, so read the spans first.
      const body = JsonTraceSerializer.serializeRequest(memory.getFinishedSpans());
      await sdk.shutdown();
      if (!body) {
        throw new Error("trace export was empty");
      }
      return `${JSON.stringify(JSON.parse(new TextDecoder().decode(body)), null, 2)}\n`;
    },
  };
}

export function spanNames(document: unknown): string[] {
  const parsed = spansSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`trace export invalid at ${parsed.error.issues[0]?.path.join(".") || "(root)"}`);
  }
  return parsed.data.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
  );
}
