import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Diff, Workspace } from "@thin-pr/specialists";
import { runShell } from "./check.js";
import type { RepoConfig } from "./config.js";
import { fileTools } from "./tools.js";

const run = promisify(execFile);

const DEFAULT_CHECK_TIMEOUT_MS = 5 * 60_000;

/** A workspace over a local git checkout that can also commit and push what changed. */
export type GitWorkspace = Workspace & {
  readonly dir: string;
  readonly baseSha: string;
  /** Commits every change and force-pushes it to `branch` on `origin`, with a lease. Returns the new head. */
  commitAndPush(input: { readonly branch: string; readonly message: string }): Promise<string>;
};

/**
 * Opens the checkout at `dir`. Its HEAD must be `baseSha`: the diff, the commit and the pushed branch all start
 * from that commit.
 */
export async function openWorkspace(input: {
  readonly dir: string;
  readonly baseSha: string;
  readonly config: RepoConfig;
  readonly checkTimeoutMs?: number;
}): Promise<GitWorkspace> {
  const { dir, config } = input;
  const top = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (top.trim() !== realpathSync(dir)) {
    throw new Error(`${dir} is not the root of a git checkout`);
  }
  const baseSha = (await git(dir, ["rev-parse", "--verify", `${input.baseSha}^{commit}`])).trim();
  const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
  if (head !== baseSha) {
    throw new Error(`checkout HEAD is ${head}, expected the base ${baseSha}`);
  }
  const timeoutMs = input.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  const files = fileTools(
    {
      list: async () => paths(await git(dir, ["ls-files", "-z"])),
      read: async (path) => {
        try {
          return readFileSync(join(dir, path), "utf8");
        } catch (error) {
          if (isMissing(error)) {
            return null;
          }
          throw error;
        }
      },
      write: async (path, content, mode) => {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content, { flag: mode === "create" ? "wx" : "w" });
        if (mode === "create") {
          // Intent-to-add keeps the new file in `git ls-files`, so listFiles and search see it.
          await git(dir, ["add", "--intent-to-add", "--", path]);
        }
      },
    },
    config.paths,
  );

  return {
    dir,
    baseSha,
    ...files,
    async runCheck(name) {
      const command = config.checks[name];
      return { name, command, ...(await runShell(command, { cwd: dir, timeoutMs })) };
    },
    async diff(): Promise<Diff> {
      // Untracked files that are not ignored would be committed, so they count.
      await git(dir, ["add", "--intent-to-add", "--all"]);
      const base = ["diff", "--no-renames", "--no-ext-diff", baseSha];
      const counts = numstat(await git(dir, [...base, "--numstat", "-z"]));
      const visible = numstat(await git(dir, [...base, "--numstat", "-z", "--ignore-all-space"]));
      const patch = await git(dir, [...base, "--no-color", "--src-prefix=a/", "--dst-prefix=b/"]);
      return { files: counts, meaningful: visible.length > 0, patch };
    },
    async commitAndPush({ branch, message }) {
      await git(dir, ["add", "--all"]);
      await git(dir, ["commit", "--quiet", "--no-verify", "--message", message]);
      // The lease is the remote-tracking ref: the push fails if the branch moved after this checkout fetched it.
      await git(dir, ["push", "--quiet", "--no-verify", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`]);
      return (await git(dir, ["rev-parse", "HEAD"])).trim();
    },
  };
}

async function git(dir: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    throw new Error(`git ${args[0] ?? ""} failed${stderr ? `: ${stderr}` : ""}`, { cause: error });
  }
}

function paths(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0);
}

// `--numstat -z` prints `added<TAB>removed<TAB>path<NUL>`. A binary file prints `-` for both counts.
function numstat(output: string): Diff["files"] {
  return paths(output).map((entry) => {
    const [added = "", removed = "", ...rest] = entry.split("\t");
    return { path: rest.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0 };
  });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "EISDIR");
}
