import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CheckResult, Diff, Workspace } from "@thin-pr/specialists";
import { runShell, scrubEnv, shareWithCheckUser } from "./check.js";
import type { RepoConfig } from "./config.js";
import { fileTools } from "./tools.js";

const run = promisify(execFile);

const DEFAULT_CHECK_TIMEOUT_MS = 5 * 60_000;

/** A command result without a check name. */
export type InstallResult = Omit<CheckResult, "name">;

/** A workspace over a local git checkout that can also install dependencies and commit and push what changed. */
export type GitWorkspace = Workspace & {
  readonly dir: string;
  readonly baseSha: string;
  /** Runs `install` from `.thin-pr.yml` like a check. Returns null when the file sets no install command. */
  install(): Promise<InstallResult | null>;
  /**
   * Commits every change and force-pushes it to `branch` on `origin`, with a lease. Returns the new head.
   * A `token` reaches only the push, as an HTTPS header for github.com in git's environment config.
   */
  commitAndPush(input: { readonly branch: string; readonly message: string; readonly token?: string }): Promise<string>;
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
  /** The user checks and installs run as. Defaults to `THIN_PR_CHECK_USER`; unset, they run as this process. */
  readonly checkUser?: string;
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
  const user = input.checkUser ?? (process.env.THIN_PR_CHECK_USER || undefined);
  if (user !== undefined) {
    shareWithCheckUser(realpathSync(dir), user);
  }
  // A turn's tool calls run at once, and a check under `user` ends by killing every process of that user.
  let queue: Promise<unknown> = Promise.resolve();
  const shell = (command: string) => {
    const done = queue.then(() => runShell(command, { cwd: dir, timeoutMs, user }));
    queue = done.catch(() => undefined);
    return done;
  };

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
      return { name, command, ...(await shell(command)) };
    },
    generators: config.generate,
    async runGenerator(command) {
      if (!config.generate.includes(command)) {
        throw new Error(`${command} is not a generator in .thin-pr.yml`);
      }
      return { command, ...(await shell(command)) };
    },
    async install() {
      const command = config.install;
      return command === undefined ? null : { command, ...(await shell(command)) };
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
    async commitAndPush({ branch, message, token }) {
      await git(dir, ["add", "--all"]);
      await git(dir, ["commit", "--quiet", "--no-verify", "--message", message]);
      // The lease is the remote-tracking ref: the push fails if the branch moved after this checkout fetched it.
      const push = ["push", "--quiet", "--no-verify", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`];
      await git(dir, push, token === undefined ? {} : authHeader(token));
      return (await git(dir, ["rev-parse", "HEAD"])).trim();
    },
  };
}

// Environment-only git config keeps the token out of argv and out of .git/config.
function authHeader(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

// Checks may have written hooks or an fsmonitor command into `.git` when they run as this process's user.
const NO_REPO_COMMANDS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

async function git(dir: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  try {
    const { stdout } = await run("git", [...NO_REPO_COMMANDS, ...args], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...scrubEnv(process.env), GIT_TERMINAL_PROMPT: "0", ...env },
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
