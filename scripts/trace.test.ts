import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spanNames } from "@thin-pr/github";
import { afterEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = ["thin-pr.run", "thin-pr.plan", "thin-pr.implement", "thin-pr.verify", "thin-pr.review", "thin-pr.write"];
const run = promisify(execFile);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("run trace", () => {
  // A child process keeps the OpenTelemetry SDK global out of this worker. Spawning pnpm and a git repo takes seconds.
  it("writes an OTLP JSON trace for the gate-pass replay", { timeout: 60_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), "thin-pr-trace-"));
    directories.push(directory);
    const path = join(directory, "trace.json");
    const output = execFileSync("pnpm", ["trace"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        THIN_PR_TRACE_PATH: path,
        THIN_PR_MODEL: "replay",
        THIN_PR_JUDGE: "replay",
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
      },
    });
    const document = JSON.parse(readFileSync(path, "utf8")) as unknown;
    expect(output).toContain("thin-pr.run");
    expect(output).toContain(path);
    expect(spanNames(document).sort()).toEqual([...expected].sort());
    expect(JSON.stringify(document)).toContain("thin-pr-orchestrator");
    expect(JSON.stringify(document)).toContain("run-7");
    expect(JSON.stringify(document)).not.toContain("host.name");
    expect(JSON.stringify(document)).not.toContain("process.pid");
  });

  it("sends the spans to the OTLP endpoint with its headers", { timeout: 60_000 }, async () => {
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
    const directory = mkdtempSync(join(tmpdir(), "thin-pr-trace-"));
    directories.push(directory);
    const path = join(directory, "trace.json");
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
    const document = JSON.parse(readFileSync(join(root, "docs/demo/trace.json"), "utf8")) as unknown;
    expect(spanNames(document).sort()).toEqual([...expected].sort());
    expect(JSON.stringify(document)).toContain("thin-pr-orchestrator");
    expect(JSON.stringify(document)).toContain("resourceSpans");
    expect(JSON.stringify(document)).not.toContain("host.name");
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
