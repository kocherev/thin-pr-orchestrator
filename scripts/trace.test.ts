import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spanNames } from "@thin-pr/github";
import { costOf } from "@thin-pr/specialists";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const steps = ["plan", "implement", "verify", "review", "write"] as const;
const expected = [
  "thin-pr.run",
  ...steps.map((step) => `thin-pr.${step}`),
  "anthropic.messages.tool_runner",
  "anthropic.custom_tool_use read_file",
  "anthropic.custom_tool_use replace",
  ...Array.from({ length: 6 }, () => "anthropic.messages.create"),
];
// The step each specialist's requests belong to.
const stepOf: Record<string, string> = { planner: "plan", implementer: "implement", reviewer: "review", "pr-writer": "write" };
// Prompt, issue, file, and reply text from the replayed run. None of it may reach a span.
const content = [
  "Sample thin pull request",
  "Run the small-feature template",
  "Plan the change.",
  "Plan the stub change",
  "export function stub",
  "return 1;",
  "src/stub.ts",
];
const directories: string[] = [];

const otlpDocument = z.object({
  resourceSpans: z.array(
    z.object({
      scopeSpans: z.array(
        z.object({
          spans: z.array(
            z.object({
              traceId: z.string(),
              spanId: z.string(),
              parentSpanId: z.string().optional(),
              name: z.string(),
              attributes: z.array(z.object({ key: z.string(), value: z.record(z.string(), z.unknown()) })),
            }),
          ),
        }),
      ),
    }),
  ),
});

const cassetteLine = z.looseObject({
  specialist: z.string(),
  model: z.enum(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]),
  response: z.object({
    body: z.looseObject({
      id: z.string(),
      usage: z.object({
        input_tokens: z.number(),
        output_tokens: z.number(),
        cache_read_input_tokens: z.number().nullable(),
        cache_creation_input_tokens: z.number().nullable(),
      }),
    }),
  }),
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "thin-pr-trace-"));
  directories.push(directory);
  return directory;
}

function flatSpans(document: unknown) {
  return otlpDocument.parse(document).resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) =>
      scope.spans.map((span) => ({
        ...span,
        attributes: new Map(span.attributes.map(({ key, value }) => [key, Object.values(value)[0]])),
      })),
    ),
  );
}

function number(value: unknown): number {
  return z.number().parse(value);
}

/** The checks every trace of the gate-pass replay passes, the committed sample included. */
function expectRunTrace(document: unknown): void {
  const text = JSON.stringify(document);
  const spans = flatSpans(document);
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const ancestor = (span: (typeof spans)[number], name: string) => {
    let current = byId.get(span.parentSpanId ?? "");
    while (current && current.name !== name) current = byId.get(current.parentSpanId ?? "");
    return current;
  };
  const cassette = readFileSync(join(root, "fixtures/gate-pass.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => cassetteLine.parse(JSON.parse(line)));

  expect(spanNames(document).sort()).toEqual([...expected].sort());
  expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
  expect(text).toContain("thin-pr-orchestrator");
  expect(text).not.toContain("host.name");
  expect(text).not.toContain("process.pid");
  for (const forbidden of content) {
    expect(text).not.toContain(forbidden);
  }

  const runSpan = spans.find((span) => span.name === "thin-pr.run");
  expect(runSpan?.parentSpanId).toBeUndefined();
  expect(runSpan?.attributes.get("thin_pr.run_id")).toBe("run-7");

  const requests = spans.filter((span) => span.name === "anthropic.messages.create");
  for (const request of requests) {
    const recorded = cassette.find((entry) => entry.response.body.id === request.attributes.get("gen_ai.response.id"));
    if (!recorded) throw new Error(`request ${request.spanId} has no recorded response`);
    const { usage } = recorded.response.body;
    expect(request.attributes.get("thin_pr.specialist")).toBe(recorded.specialist);
    expect(ancestor(request, `thin-pr.${stepOf[recorded.specialist] ?? ""}`)).toBeDefined();
    expect(request.attributes.get("gen_ai.provider.name")).toBe("anthropic");
    expect(request.attributes.get("gen_ai.request.model")).toBe(recorded.model);
    expect(request.attributes.get("gen_ai.response.model")).toBe(recorded.model);
    expect(request.attributes.get("gen_ai.request.reasoning.level")).toEqual(expect.any(String));
    expect(request.attributes.get("gen_ai.usage.output_tokens")).toBe(usage.output_tokens);
    expect(request.attributes.get("gen_ai.usage.cache_read.input_tokens")).toBe(usage.cache_read_input_tokens ?? 0);
    // The SDK counts cache reads and writes as input. The meter prices the same response.
    expect(request.attributes.get("gen_ai.usage.input_tokens")).toBe(
      usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    );
    expect(request.attributes.get("thin_pr.cost_usd")).toBeCloseTo(costOf(recorded.model, usage), 12);
  }

  for (const step of steps) {
    const stepSpan = spans.find((span) => span.name === `thin-pr.${step}`);
    if (!stepSpan) throw new Error(`no span for ${step}`);
    expect(stepSpan.parentSpanId).toBe(runSpan?.spanId);
    expect(stepSpan.attributes.get("thin_pr.loop")).toBe(0);
    expect(stepSpan.attributes.get("thin_pr.attempts")).toBe(1);
    const own = requests.filter((request) => ancestor(request, stepSpan.name) === stepSpan);
    const sum = (key: string) => own.reduce((total, request) => total + number(request.attributes.get(key)), 0);
    expect(stepSpan.attributes.get("thin_pr.usage.requests")).toBe(own.length);
    expect(stepSpan.attributes.get("thin_pr.usage.input_tokens")).toBe(sum("gen_ai.usage.input_tokens"));
    expect(stepSpan.attributes.get("thin_pr.usage.output_tokens")).toBe(sum("gen_ai.usage.output_tokens"));
    expect(stepSpan.attributes.get("thin_pr.usage.cost_usd")).toBeCloseTo(sum("thin_pr.cost_usd"), 12);
  }
  const total = requests.reduce((sum, request) => sum + number(request.attributes.get("thin_pr.cost_usd")), 0);
  expect(runSpan?.attributes.get("thin_pr.usage.cost_usd")).toBeCloseTo(total, 12);
}

describe("run trace", () => {
  // A child process keeps the OpenTelemetry SDK global out of this worker.
  it("writes an OTLP JSON file with run, step, and model request spans", async () => {
    const path = join(scratch(), "trace.json");
    const { stdout } = await run("pnpm", ["trace"], {
      cwd: root,
      env: {
        ...process.env,
        THIN_PR_TRACE_PATH: path,
        THIN_PR_MODEL: "replay",
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
      },
    });
    expect(stdout).toContain(path);
    expectRunTrace(JSON.parse(readFileSync(path, "utf8")) as unknown);
  });

  it("sends the spans to the OTLP endpoint with its headers", async () => {
    const received: { path: string; header: string | undefined; body: string }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const header = request.headers["x-test-team"];
        received.push({
          path: request.url ?? "",
          header: typeof header === "string" ? header : undefined,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("receiver has no port");
    const path = join(scratch(), "trace.json");
    try {
      // execFileSync would block the receiver in this process, so the child runs async.
      const { stdout } = await run("pnpm", ["trace"], {
        cwd: root,
        env: {
          ...process.env,
          THIN_PR_TRACE_PATH: path,
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
          OTEL_EXPORTER_OTLP_HEADERS: "x-test-team=thin-pr",
        },
      });
      expect(stdout).toContain("sent to the OTLP endpoint");
    } finally {
      server.close();
    }
    expect(existsSync(path)).toBe(false);
    expect(received.map((request) => request.path)).toEqual(received.map(() => "/v1/traces"));
    expect(received.map((request) => request.header)).toEqual(received.map(() => "thin-pr"));
    const names = received.flatMap((request) => spanNames(JSON.parse(request.body) as unknown));
    expect(names.sort()).toEqual([...expected].sort());
  });

  it("keeps the sample trace", () => {
    expectRunTrace(JSON.parse(readFileSync(join(root, "docs/demo/trace.json"), "utf8")) as unknown);
  });

  it("uploads the trace from CI and from the labeled-issue workflow", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const labeled = readFileSync(join(root, ".github/workflows/thin-pr.yml"), "utf8");
    expect(ci).toContain("run: pnpm trace");
    expect(ci).toContain("actions/upload-artifact@v7");
    expect(labeled).toContain("THIN_PR_TRACE_PATH: artifacts/trace.json");
    expect(labeled).toContain("actions/upload-artifact@v7");
  });
});
