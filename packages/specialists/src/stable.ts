import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

/**
 * Check output with what differs between machines and runs taken out: local paths, vitest timings, and the unittest
 * lines that change between Python versions. Replay hashes requests through this, and the eval stores run records
 * through it, so both stay the same on any machine.
 */
export function stableText(text: string): string {
  const lines = stripLocalPaths(text)
    .split("\n")
    .filter((line) => !/^\s*(Start at|Duration)\s/.test(line))
    .map((line) => line.replace(/ \d+(?:\.\d+)?m?s$/, ""));
  return unittestSignal(lines).join("\n");
}

// A path ends at a slash, whitespace, a quote, or punctuation that follows a path in a log.
const PATH_END = String.raw`(?=[/\s"'):;,.]|$)`;
const NOT_INSIDE_A_PATH = String.raw`(?<![\w.~-])`;
const TEMP_ROOTS = roots(
  [tmpdir(), realTmpdir()],
  // A macOS per-user temp folder from any machine, and /tmp.
  [String.raw`(?:/private)?/var/folders/[^/\s"']+/[^/\s"']+/T`, "/(?:private/)?tmp"],
);
const HOME_ROOTS = roots([homedir()], [String.raw`/(?:Users|home)/[^/\s"']+`]);
const SCRATCH_CHECKOUT = new RegExp(String.raw`(?:${TEMP_ROOTS})/thin-pr-(?:repo|local)-[A-Za-z0-9]+/checkout${PATH_END}`, "g");
const TEMP = new RegExp(String.raw`(?:${TEMP_ROOTS})${PATH_END}`, "g");
const HOME = new RegExp(String.raw`(?:${HOME_ROOTS})${PATH_END}`, "g");

/** A scratch checkout or local-run worktree becomes `.`, any other temp folder `$TMPDIR`, and a home folder `~`. */
export function stripLocalPaths(text: string): string {
  return text.replace(SCRATCH_CHECKOUT, ".").replace(TEMP, "$$TMPDIR").replace(HOME, "~");
}

/** One regex alternation: this machine's folders, escaped, then the patterns that match them on any machine. None
 * matches inside a longer path, so `src/tmp` stays put where this machine's temp folder is `/tmp`. */
function roots(dirs: readonly string[], patterns: readonly string[]): string {
  const literal = [...new Set(dirs.filter((dir) => dir.length > 1))].map((dir) => dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `${NOT_INSIDE_A_PATH}(?:${[...literal, ...patterns].join("|")})`;
}

function realTmpdir(): string {
  try {
    return realpathSync(tmpdir());
  } catch {
    return tmpdir();
  }
}

/**
 * Traceback frames, source lines and carets differ between Python versions, so a unittest report keeps only these
 * lines: each `FAIL:` or `ERROR:` line with the test id in the Python 3.10 form `name (module.Class)`, the last line
 * of each traceback (the exception and its message), `Ran N tests`, and `OK` or `FAILED (...)`. Lines before the
 * report, such as a step summary's first line, stay. Text with no `Ran N tests` line is not a unittest report.
 */
function unittestSignal(lines: readonly string[]): string[] {
  const start = lines.findIndex((line) => /^([.FEsxu]+|=+|-+|(FAIL|ERROR): .*|Ran \d+ tests?\b.*)$/.test(line));
  if (start < 0 || !lines.some((line) => /^Ran \d+ tests?\b/.test(line))) {
    return [...lines];
  }
  const kept = lines.slice(0, start);
  let inTraceback = false;
  for (const line of lines.slice(start)) {
    const failure = /^((?:FAIL|ERROR): (\S+) \(.+?)(?:\.\2)?\)$/.exec(line);
    const ran = /^Ran \d+ tests?\b/.exec(line);
    if (line === "Traceback (most recent call last):") {
      inTraceback = true;
    } else if (inTraceback) {
      // Frames and their source lines are indented. The first line that is not is the exception.
      if (!line.startsWith(" ")) {
        inTraceback = false;
        kept.push(line);
      }
    } else if (failure) {
      kept.push(`${failure[1]})`);
    } else if (ran) {
      kept.push(ran[0]);
    } else if (/^(OK|FAILED)\b/.test(line)) {
      kept.push(line);
    }
  }
  return kept;
}
