import { spawn, spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

const LOG_TAIL_CHARS = 4096;
const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD/i;
// OTEL_EXPORTER_OTLP_HEADERS carries a trace backend's API key under a name the pattern above misses.
const SECRET_PREFIX = /^(GITHUB|ANTHROPIC|OTEL)_/i;

/** The environment a check sees: the parent's, minus anything that looks like a credential. */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_NAME.test(name) && !SECRET_PREFIX.test(name)));
}

// sudo sets these for the check user. Passing the run's own would point the check at the run's home.
const USER_VARS = /^(HOME|USER|LOGNAME|SHELL|MAIL|PWD|OLDPWD|SUDO_\w+)$/;
// sudo also adds these. SUDO_COMMAND holds the whole command line, which a check has no use for.
const SUDO_VARS = ["SUDO_COMMAND", "SUDO_USER", "SUDO_UID", "SUDO_GID", "SUDO_HOME"];

/**
 * Lets `user` write the checkout but not `.git`, and reach it and the tools on PATH through the folders above them.
 * New files the run or the check creates stay writable by both.
 */
export function shareWithCheckUser(dir: string, user: string): void {
  const self = process.getuid?.();
  setfacl(["-R", "-m", `u:${user}:rwX,d:u:${user}:rwX,d:u:${self}:rwX`, dir]);
  setfacl(["-R", "-b", join(dir, ".git")]);
  const tools = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
  const above = new Set<string>();
  for (const start of [dir, ...tools]) {
    for (let parent = dirname(start); parent !== dirname(parent); parent = dirname(parent)) {
      above.add(parent);
    }
  }
  for (const parent of above) {
    // Only this process's folders, and only search access: a home folder at 750 hides the tools under it.
    if (statSync(parent, { throwIfNoEntry: false })?.uid === self) {
      setfacl(["-m", `u:${user}:x`, parent]);
    }
  }
}

/**
 * Runs `command` through `/bin/sh` in its own process group, so a timeout kills everything it started.
 * The result keeps the last 4 KB of stdout and stderr, interleaved as they arrived.
 *
 * With `user`, the command runs as that user through `sudo`. A scrubbed environment alone does not keep secrets
 * from a check, since any process of the run's own user can read `/proc/<pid>/environ` of the run and its parents.
 * Once the check ends, every process of `user` is killed, including any it moved out of its process group.
 */
export function runShell(
  command: string,
  options: { readonly cwd: string; readonly timeoutMs: number; readonly user?: string },
): Promise<{ exitCode: number; durationMs: number; logTail: string }> {
  const { user } = options;
  const env = scrubEnv(process.env);
  const [file, args] =
    user === undefined
      ? ["/bin/sh", ["-c", command]]
      : ["sudo", ["-n", "-H", "-u", user, "--", "env", ...SUDO_VARS.flatMap((name) => ["-u", name]), ...checkUserEnv(env, options.cwd), "/bin/sh", "-c", command]];
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(file, args, { cwd: options.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const append = (chunk: string) => {
      log = (log + chunk).slice(-LOG_TAIL_CHARS);
    };
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (user !== undefined) {
        killAll(user);
        return;
      }
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group exited between the timer firing and the kill.
      }
    }, options.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (user !== undefined) {
        killAll(user);
      }
      if (timedOut) {
        append(`\ntimed out after ${options.timeoutMs} ms\n`);
      }
      resolve({
        // 124 is the exit status `timeout(1)` uses for the same case.
        exitCode: timedOut ? 124 : (code ?? 1),
        durationMs: Math.round(performance.now() - started),
        logTail: log,
      });
    });
  });
}

/**
 * The check's variables as `NAME=value` arguments for `env`, since sudo resets the environment. Git refuses a repo
 * another user owns, so the checkout is marked safe. The check user cannot write `.git`, so its config is the run's.
 */
function checkUserEnv(env: NodeJS.ProcessEnv, checkout: string): string[] {
  const vars = Object.entries(env)
    .filter(([name, value]) => value !== undefined && !USER_VARS.test(name) && !name.startsWith("GIT_CONFIG_"))
    .map(([name, value]) => `${name}=${value}`);
  return [...vars, "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=safe.directory", `GIT_CONFIG_VALUE_0=${realpathSync(checkout)}`];
}

/** Kills every process of `user`. `kill -1` skips the shell that sends it, and the run's user cannot signal them. */
function killAll(user: string): void {
  spawnSync("sudo", ["-n", "-u", user, "--", "/bin/sh", "-c", "kill -9 -1"], { stdio: "ignore" });
}

function setfacl(args: readonly string[]): void {
  const result = spawnSync("setfacl", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`setfacl ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
}
