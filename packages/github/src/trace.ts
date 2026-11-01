import { createServer, type Server } from "node:http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export const TRACE_SERVICE_NAME = "thin-pr-orchestrator";

export type TraceSession = {
  stop(): Promise<string>;
};

export async function startTrace(): Promise<TraceSession> {
  // The trace file is the signal. Metrics and logs would wait on a collector that is not running.
  process.env.OTEL_METRICS_EXPORTER = "none";
  process.env.OTEL_LOGS_EXPORTER = "none";

  const bodies: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("trace receiver has no port");
  }

  const sdk = new NodeSDK({
    // Host and process detectors would put the machine name into the trace file.
    autoDetectResources: false,
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: TRACE_SERVICE_NAME,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `http://127.0.0.1:${address.port}/v1/traces`,
    }),
  });
  sdk.start();

  return {
    async stop() {
      try {
        await sdk.shutdown();
      } finally {
        await closeServer(server);
      }
      return combineTraceExports(bodies);
    },
  };
}

export function combineTraceExports(bodies: readonly string[]): string {
  const documents = bodies.filter((body) => body.trim().length > 0).map((body) => parseExport(body));
  if (documents.length === 0) {
    throw new Error("trace export was empty");
  }
  const resourceSpans = documents.flatMap((document) => document);
  return `${JSON.stringify({ resourceSpans }, null, 2)}\n`;
}

export function spanNames(document: unknown): string[] {
  const names: string[] = [];
  for (const resourceSpan of resourceSpansOf(document)) {
    const scopes = arrayField(resourceSpan, "scopeSpans");
    for (const scope of scopes) {
      for (const span of arrayField(scope, "spans")) {
        const name = objectValue(span).name;
        if (typeof name === "string" && name.length > 0) {
          names.push(name);
        }
      }
    }
  }
  return names;
}

function parseExport(body: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new Error("trace export is not JSON");
  }
  return resourceSpansOf(value);
}

function resourceSpansOf(value: unknown): unknown[] {
  return arrayField(value, "resourceSpans");
}

function arrayField(value: unknown, field: string): unknown[] {
  const record = objectValue(value);
  const items = record[field];
  if (!Array.isArray(items)) {
    throw new Error(`trace export has no ${field}`);
  }
  return items;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("trace export must be an object");
  }
  return value as Record<string, unknown>;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
