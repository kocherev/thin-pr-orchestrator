import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type ScratchRepo = {
  /** The checkout, on `main` at `baseSha`. */
  readonly dir: string;
  readonly baseSha: string;
  /** The bare repo behind `origin`. */
  readonly remote: string;
  remove(): void;
};

/**
 * A throwaway checkout with one commit of `files` and a bare `origin`, for tests and the replay eval.
 * Its local git config sets an identity and turns off commit signing, so commits work on any machine.
 */
export function createScratchRepo(files: Readonly<Record<string, string>>): ScratchRepo {
  const root = mkdtempSync(join(tmpdir(), "thin-pr-repo-"));
  const remote = join(root, "origin.git");
  const dir = join(root, "checkout");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  mkdirSync(dir);
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "config", "user.name", "thin-pr");
  git(dir, "config", "user.email", "thin-pr@localhost");
  git(dir, "config", "commit.gpgsign", "false");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--no-verify", "--message", "Base");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "--quiet", "origin", "main");
  return {
    dir,
    baseSha: git(dir, "rev-parse", "HEAD"),
    remote,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
