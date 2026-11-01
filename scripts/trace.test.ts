import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spanNames } from "@thin-pr/github";
import { afterEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = ["thin-pr.run", "thin-pr.plan", "thin-pr.implement", "thin-pr.test", "thin-pr.review", "thin-pr.gate"];
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("run trace", () => {
  it("writes an OTLP JSON trace for the gate-pass replay", () => {
    const directory = mkdtempSync(join(tmpdir(), "thin-pr-trace-"));
    directories.push(directory);
    const path = join(directory, "trace.json");
    const output = execFileSync("pnpm", ["trace"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, THIN_PR_TRACE_PATH: path, THIN_PR_MODEL: "replay", THIN_PR_JUDGE: "replay" },
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
