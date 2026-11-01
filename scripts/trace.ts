import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileChange } from "@thin-pr/gate";
import { runAction, spanNames, startTrace } from "@thin-pr/github";
import { ReplayModelClient } from "@thin-pr/specialists";
import { replayGitHub } from "./eval.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const STUB_CHANGE: FileChange = {
  path: "src/stub.ts",
  before: "export function stub(): number {\n  return 0;\n}\n",
  after: "export function stub(): number {\n  return 1;\n}\n",
};

export async function runTrace(workspace = root): Promise<string> {
  const tracing = await startTrace();
  const directory = mkdtempSync(join(tmpdir(), "thin-pr-trace-"));
  let failure: unknown;
  try {
    const result = await runAction({
      payload: jsonFile(join(workspace, "fixtures", "sample-issue-labeled.json")),
      workspace,
      runId: "run-7",
      logPath: join(directory, "events.sqlite"),
      github: replayGitHub(),
      changes: [STUB_CHANGE],
      model: modelFromFixture(jsonFile(join(workspace, "fixtures", "gate-pass.json"))),
    });
    if (result.status !== "completed") {
      failure = new Error(`trace replay finished ${result.status}`);
    }
  } catch (error) {
    failure = error;
  }
  const document = await tracing.stop();
  rmSync(directory, { recursive: true, force: true });
  if (failure) {
    throw failure;
  }
  return document;
}

function modelFromFixture(value: unknown): ReplayModelClient {
  const fixture = objectValue(value);
  return new ReplayModelClient({
    planner: JSON.stringify(fixture.plan),
    implementer: JSON.stringify(fixture.implement),
    tester: JSON.stringify(fixture.test),
    reviewer: JSON.stringify(fixture.review),
    "pr-writer": JSON.stringify(fixture.pullRequest),
  });
}

function jsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("gate fixture must be an object");
  }
  return value as Record<string, unknown>;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  runTrace()
    .then((document) => {
      const names = spanNames(JSON.parse(document) as unknown);
      const path = process.env.THIN_PR_TRACE_PATH;
      if (path) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, document);
        process.stdout.write(`Trace\nspans: ${names.join(", ")}\nfile: ${path}\n`);
        return;
      }
      process.stdout.write(document);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "trace failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
