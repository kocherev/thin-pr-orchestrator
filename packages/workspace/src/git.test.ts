import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createScratchRepo, loadRepoConfig, openWorkspace, type RepoConfig } from "./index.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const BASE_FILES = {
  "src/counter.ts": "export function decrement(value: number): number {\n  return value - 1;\n}\n",
  "README.md": "# Sample\n",
  ".github/workflows/ci.yml": "name: CI\n",
};

describe("GitWorkspace", () => {
  it("creates a file inside the allowed paths and refuses the rest", async () => {
    const workspace = await open();

    await workspace.createFile("src/reset.ts", "export const reset = 0;\n");
    expect(await workspace.readFile("src/reset.ts")).toBe("export const reset = 0;\n");
    expect(await workspace.listFiles()).toContain("src/reset.ts");
    await expect(workspace.createFile("src/reset.ts", "")).rejects.toThrow("createFile: src/reset.ts already exists");
    await expect(workspace.createFile(".github/workflows/x.yml", "")).rejects.toThrow("matches a denied path");
    await expect(workspace.createFile("scripts/x.sh", "")).rejects.toThrow("is outside the allowed paths");
    await expect(workspace.createFile("src/../../x.ts", "")).rejects.toThrow("path must stay inside the repo");
    await expect(workspace.readFile(".git/config")).rejects.toThrow("path must stay inside the repo");
    expect(await workspace.readFile("src/missing.ts")).toBeNull();
  });

  it("replaces text that matches exactly once and names the count otherwise", async () => {
    const workspace = await open();

    await workspace.replace("src/counter.ts", "value - 1", "Math.max(0, value - 1)");
    expect(await workspace.readFile("src/counter.ts")).toContain("return Math.max(0, value - 1);");
    await expect(workspace.replace("src/counter.ts", "value + 1", "x")).rejects.toThrow(
      "replace: oldText matches 0 times in src/counter.ts; it must match exactly once",
    );
    await expect(workspace.replace("src/counter.ts", "value", "x")).rejects.toThrow("oldText matches 2 times");
    await expect(workspace.replace("src/nope.ts", "a", "b")).rejects.toThrow("replace: src/nope.ts does not exist");
  });

  it("searches tracked and created files with a regex or a fixed string", async () => {
    const workspace = await open();
    await workspace.createFile("src/reset.ts", "export const reset = (): number => 0;\n");

    expect(await workspace.search("export (function|const)")).toEqual([
      { path: "src/counter.ts", line: 1, text: "export function decrement(value: number): number {" },
      { path: "src/reset.ts", line: 1, text: "export const reset = (): number => 0;" },
    ]);
    // "reset = (" is not a valid regex, so it is matched as written.
    expect(await workspace.search("reset = (")).toEqual([
      { path: "src/reset.ts", line: 1, text: "export const reset = (): number => 0;" },
    ]);
  });

  it("measures the diff against the base, including new files", async () => {
    const workspace = await open();
    await workspace.replace("src/counter.ts", "value - 1", "Math.max(0, value - 1)");
    await workspace.createFile("src/reset.ts", "export function reset(): number {\n  return 0;\n}\n");

    const diff = await workspace.diff();
    expect(diff.files).toEqual([
      { path: "src/counter.ts", added: 1, removed: 1 },
      { path: "src/reset.ts", added: 3, removed: 0 },
    ]);
    expect(diff.meaningful).toBe(true);
    expect(diff.patch).toContain("+++ b/src/reset.ts");
    expect(diff.patch).toContain("-  return value - 1;\n+  return Math.max(0, value - 1);");
  });

  it("marks a whitespace-only diff as not meaningful", async () => {
    const workspace = await open();
    await workspace.replace("src/counter.ts", "  return value - 1;", "    return value - 1;  ");

    const diff = await workspace.diff();
    expect(diff.files).toEqual([{ path: "src/counter.ts", added: 1, removed: 1 }]);
    expect(diff.meaningful).toBe(false);
  });

  it("runs a configured check and keeps the tail of its output", async () => {
    const workspace = await open({ typecheck: "echo checking; echo broken >&2; exit 3", test: "true" });

    const result = await workspace.runCheck("typecheck");
    expect(result).toMatchObject({ name: "typecheck", command: "echo checking; echo broken >&2; exit 3", exitCode: 3 });
    expect(result.logTail).toBe("checking\nbroken\n");
    expect((await workspace.runCheck("test")).exitCode).toBe(0);
  });

  it("hides credential variables from a check", async () => {
    const value = randomUUID();
    const names = ["THIN_PR_TEST_TOKEN", "THIN_PR_API_KEY", "GITHUB_ACTOR", "ANTHROPIC_BASE_URL", "THIN_PR_VISIBLE"];
    for (const name of names) {
      process.env[name] = value;
      cleanups.push(() => delete process.env[name]);
    }
    const workspace = await open({ typecheck: names.map((name) => `echo "${name}=$${name}"`).join("; "), test: "true" });

    const { logTail } = await workspace.runCheck("typecheck");
    expect(logTail.split("\n").filter(Boolean)).toEqual([
      "THIN_PR_TEST_TOKEN=",
      "THIN_PR_API_KEY=",
      "GITHUB_ACTOR=",
      "ANTHROPIC_BASE_URL=",
      `THIN_PR_VISIBLE=${value}`,
    ]);
  });

  it("kills a check and everything it started when the timeout passes", async () => {
    const workspace = await open({ typecheck: "sleep 30 & sleep 30; wait", test: "true" }, 200);

    const result = await workspace.runCheck("typecheck");
    expect(result.exitCode).toBe(124);
    expect(result.durationMs).toBeLessThan(5_000);
    expect(result.logTail).toContain("timed out after 200 ms");
  });

  it("commits and pushes the branch, and a later run from a fresh base replaces it", async () => {
    const repo = scratch();
    const first = await openWorkspace({ dir: repo.dir, baseSha: repo.baseSha, config: loadRepoConfig(repo.dir) });
    await first.createFile("src/reset.ts", "export const reset = 0;\n");
    const firstHead = await first.commitAndPush({ branch: "thin-pr/7", message: "Apply thin-pr/#7" });
    expect(gitIn(repo.remote, "rev-parse", "thin-pr/7")).toBe(firstHead);
    expect(gitIn(repo.remote, "log", "--format=%s", "thin-pr/7")).toBe("Apply thin-pr/#7\nBase");

    // The default branch moves on, and the label is added again. The new run starts from a fresh clone.
    const clone = cloneWithCommit(repo.remote, "README.md", "# Sample\n\nMore.\n");
    const second = await openWorkspace({ dir: clone.dir, baseSha: clone.head, config: loadRepoConfig(clone.dir) });
    await second.replace("src/counter.ts", "value - 1", "Math.max(0, value - 1)");
    const secondHead = await second.commitAndPush({ branch: "thin-pr/7", message: "Apply thin-pr/#7" });

    expect(gitIn(repo.remote, "rev-parse", "thin-pr/7")).toBe(secondHead);
    expect(gitIn(repo.remote, "rev-parse", "thin-pr/7^")).toBe(clone.head);
    expect(gitIn(repo.remote, "ls-tree", "--name-only", "-r", "thin-pr/7")).not.toContain("src/reset.ts");

    // The first checkout still believes the branch is at its own commit, so its lease is stale.
    await first.replace("src/reset.ts", "0", "1");
    await expect(first.commitAndPush({ branch: "thin-pr/7", message: "Apply thin-pr/#7" })).rejects.toThrow("stale info");
  });

  it("runs the install command like a check and skips it when none is set", async () => {
    const repo = scratch();
    const config = { ...loadRepoConfig(repo.dir), install: "echo installed; exit 4" };
    const workspace = await openWorkspace({ dir: repo.dir, baseSha: repo.baseSha, config });

    expect(await workspace.install()).toMatchObject({ command: "echo installed; exit 4", exitCode: 4, logTail: "installed\n" });
    expect(await (await open()).install()).toBeNull();
  });

  it("keeps the push token out of .git/config and away from checks", async () => {
    const token = randomUUID();
    process.env.GITHUB_TOKEN = token;
    cleanups.push(() => delete process.env.GITHUB_TOKEN);
    const probe = "env | grep -c GITHUB_TOKEN; grep -c -i extraheader .git/config";
    const workspace = await open({ typecheck: probe, test: "true" });

    await workspace.createFile("src/reset.ts", "export const reset = 0;\n");
    const head = await workspace.commitAndPush({ branch: "thin-pr/7", message: "Apply thin-pr/#7", token });

    expect(gitIn(workspace.dir, "ls-remote", "origin", "thin-pr/7")).toContain(head);
    const config = readFileSync(join(workspace.dir, ".git", "config"), "utf8");
    expect(config).not.toContain(token);
    expect(config).not.toContain(Buffer.from(`x-access-token:${token}`).toString("base64"));
    expect((await workspace.runCheck("typecheck")).logTail).toBe("0\n0\n");
  });

  it("refuses a checkout whose HEAD is not the base", async () => {
    const repo = scratch();
    const clone = cloneWithCommit(repo.remote, "README.md", "# Moved\n");
    await expect(openWorkspace({ dir: clone.dir, baseSha: repo.baseSha, config: loadRepoConfig(clone.dir) })).rejects.toThrow(
      `checkout HEAD is ${clone.head}, expected the base ${repo.baseSha}`,
    );
  });
});

function scratch() {
  const repo = createScratchRepo(BASE_FILES);
  cleanups.push(() => repo.remove());
  return repo;
}

async function open(checks?: RepoConfig["checks"], checkTimeoutMs?: number) {
  const repo = scratch();
  const config = loadRepoConfig(repo.dir);
  return openWorkspace({ dir: repo.dir, baseSha: repo.baseSha, config: { ...config, checks: checks ?? config.checks }, checkTimeoutMs });
}

function cloneWithCommit(remote: string, path: string, content: string) {
  const root = mkdtempSync(join(tmpdir(), "thin-pr-clone-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "checkout");
  gitIn(root, "clone", "--quiet", remote, dir);
  gitIn(dir, "config", "user.name", "thin-pr");
  gitIn(dir, "config", "user.email", "thin-pr@localhost");
  gitIn(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, path), content);
  gitIn(dir, "commit", "--quiet", "--all", "--message", "Move main");
  gitIn(dir, "push", "--quiet", "origin", "main");
  return { dir, head: gitIn(dir, "rev-parse", "HEAD") };
}

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
