import { posix } from "node:path";
import picomatch from "picomatch";
import type { RepoConfig } from "./config.js";

export type PathVerdict = "allowed" | "denied" | "not-allowed";

/** Where `path` stands under the repo's path rules. A deny match wins over an allow match. */
export function classifyPath(rules: RepoConfig["paths"], path: string): PathVerdict {
  if (picomatch.isMatch(path, rules.deny, { dot: true })) {
    return "denied";
  }
  return picomatch.isMatch(path, rules.allow, { dot: true }) ? "allowed" : "not-allowed";
}

/** A repo-relative path with forward slashes. Throws when the path leaves the repo or points into `.git`. */
export function repoPath(path: string): string {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  const parts = normalized.split("/");
  if (path.length === 0 || posix.isAbsolute(normalized) || parts[0] === ".." || parts[0] === "." || parts[0] === ".git") {
    throw new Error(`path must stay inside the repo: ${path}`);
  }
  return normalized;
}
