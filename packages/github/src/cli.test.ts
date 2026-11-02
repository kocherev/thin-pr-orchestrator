import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createScratchRepo } from "@thin-pr/workspace";
import type { RunRecord } from "./record.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const bin = join(root, "packages", "github", "bin", "thin-pr.js");
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe("thin-pr run", () => {
  // tsc and vitest run for real on the sample package.
  it("replays an eval case on a local checkout and leaves the change on a local branch", async () => {
    const repo = sampleRepo();
    const issueFile = join(repo.dir, "..", "issue.md");
    writeFileSync(issueFile, "# Clamp decrement at zero\n\ndecrement in src/counter.ts should not return a negative count.\n");

    const result = await thinPr(["run", "--repo", repo.dir, "--issue", issueFile], {
      THIN_PR_CASSETTE: join(root, "evals", "cases", "01-clamp-decrement", "cassette.jsonl"),
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("## Run report");
    expect(result.stdout).toContain("- gate/tests: success. PASS: Tests passed: vitest run");
    expect(result.stdout).toContain("Status: opened\nBranch: thin-pr/local-1\n");
    expect(git(repo.dir, "log", "--format=%s", "thin-pr/local-1")).toBe("Apply thin-pr/#1\nBase");
    expect(git(repo.dir, "diff", "--name-only", "main", "thin-pr/local-1")).toBe("src/counter.ts");
    // The checkout is untouched, the temporary worktree is gone, and nothing reached origin.
    expect(git(repo.dir, "status", "--porcelain")).toBe("");
    expect(git(repo.dir, "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(repo.remote, "branch", "--list", "thin-pr/*")).toBe("");

    const recordPath = /^Record: (.+)$/m.exec(result.stdout)?.[1] ?? "";
    expect(recordPath.startsWith(join(repo.dir, ".git", "thin-pr", "runs", "local-"))).toBe(true);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as RunRecord;
    expect(record).toMatchObject({
      version: 1,
      repo: "local/checkout",
      issue: { number: 1, title: "Clamp decrement at zero", url: "" },
      template: "small-feature",
      status: "opened",
      pullRequest: null,
      diff: { files: [{ path: "src/counter.ts" }] },
    });
    expect(record.gate.every((rule) => rule.verdict === "PASS")).toBe(true);
    expect(record.totals.costUsd).toBeGreaterThan(0);
  });

  it("prints the usage and exits 2 without a repo", async () => {
    const result = await thinPr(["run", "--issue", "Fix it"], {});

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: thin-pr run --repo <path> --issue <file.md | text>");
  });
});

function sampleRepo() {
  const sample = join(root, "evals", "sample-repo");
  const files = readdirSync(sample, { recursive: true, encoding: "utf8" }).filter((path) => statSync(join(sample, path)).isFile());
  const repo = createScratchRepo(Object.fromEntries(files.map((path) => [path, readFileSync(join(sample, path), "utf8")])));
  cleanups.push(() => repo.remove());
  return repo;
}

async function thinPr(args: readonly string[], env: Readonly<Record<string, string>>) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [bin, ...args], {
      encoding: "utf8",
      // The sample package checks with bare tsc and vitest, as in pnpm eval.
      env: { ...process.env, PATH: [join(root, "node_modules", ".bin"), process.env.PATH].join(delimiter), THIN_PR_MODEL: "", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && "stdout" in error && "stderr" in error) {
      return { code: Number(error.code), stdout: String(error.stdout), stderr: String(error.stderr) };
    }
    throw error;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
