import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAction, spanNames, startTrace } from "@thin-pr/github";
import { createScratchRepo } from "@thin-pr/workspace";
import { replayGitHub, replayModel } from "./eval.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function runTrace(workspace = root): Promise<string> {
  const tracing = await startTrace();
  const directory = mkdtempSync(join(tmpdir(), "thin-pr-trace-"));
  // gate-pass.json edits src/stub.ts. The checks only print, so the trace measures the orchestrator.
  const repo = createScratchRepo({
    "src/stub.ts": "export function stub(): number {\n  return 0;\n}\n",
    ".thin-pr.yml": "checks:\n  typecheck: echo typecheck ok\n  test: echo test ok\n",
  });
  let failure: unknown;
  try {
    const result = await runAction({
      payload: jsonFile(join(workspace, "fixtures", "sample-issue-labeled.json")),
      templates: join(workspace, "templates"),
      checkout: repo.dir,
      baseSha: repo.baseSha,
      runId: "run-7",
      logPath: join(directory, "events.sqlite"),
      github: replayGitHub(),
      model: replayModel(jsonFile(join(workspace, "fixtures", "gate-pass.json"))),
    });
    if (result.status !== "opened") {
      failure = new Error(`trace replay finished ${result.status}`);
    }
  } catch (error) {
    failure = error;
  }
  const document = await tracing.stop();
  rmSync(directory, { recursive: true, force: true });
  repo.remove();
  if (failure) {
    throw failure;
  }
  return document;
}

function jsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
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
