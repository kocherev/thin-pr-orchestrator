import { spawn } from "node:child_process";

const LOG_TAIL_CHARS = 4096;
const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD/i;
const SECRET_PREFIX = /^(GITHUB|ANTHROPIC)_/i;

/** The environment a check sees: the parent's, minus anything that looks like a credential. */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_NAME.test(name) && !SECRET_PREFIX.test(name)));
}

/**
 * Runs `command` through `/bin/sh` in its own process group, so a timeout kills everything it started.
 * The result keeps the last 4 KB of stdout and stderr, interleaved as they arrived.
 */
export function runShell(
  command: string,
  options: { readonly cwd: string; readonly timeoutMs: number },
): Promise<{ exitCode: number; durationMs: number; logTail: string }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: options.cwd,
      env: scrubEnv(process.env),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const append = (chunk: string) => {
      log = (log + chunk).slice(-LOG_TAIL_CHARS);
    };
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
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
