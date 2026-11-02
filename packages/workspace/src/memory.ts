import type { CheckResult, Diff, Workspace } from "@thin-pr/specialists";
import { DEFAULT_CONFIG } from "./config.js";
import { fileTools } from "./tools.js";

type CheckOutcome = { readonly exitCode: number; readonly logTail: string };

/**
 * An in-memory workspace for tests. Path rules are the `.thin-pr.yml` defaults, and each check returns the
 * outcome it was given.
 */
export function createMemoryWorkspace(
  files: Readonly<Record<string, string>>,
  checks: Readonly<Record<CheckResult["name"], CheckOutcome>>,
): Workspace {
  const base = new Map(Object.entries(files));
  const current = new Map(base);
  return {
    ...fileTools(
      {
        list: async () => [...current.keys()].sort(),
        read: async (path) => current.get(path) ?? null,
        write: async (path, content) => {
          current.set(path, content);
        },
      },
      DEFAULT_CONFIG.paths,
    ),
    async runCheck(name) {
      return { name, command: DEFAULT_CONFIG.checks[name], durationMs: 0, ...checks[name] };
    },
    async diff(): Promise<Diff> {
      const changed: Diff["files"] = [];
      const patch: string[] = [];
      let meaningful = false;
      for (const path of [...current.keys()].sort()) {
        const before = base.get(path) ?? null;
        const after = current.get(path) ?? "";
        if (before === after) {
          continue;
        }
        // shortcut: a changed file counts as fully rewritten; GitWorkspace reports real line counts.
        const removed = lines(before ?? "");
        const added = lines(after);
        changed.push({ path, added: added.length, removed: removed.length });
        meaningful ||= squash(before ?? "") !== squash(after);
        patch.push(
          `--- ${before === null ? "/dev/null" : `a/${path}`}`,
          `+++ b/${path}`,
          `@@ -1,${removed.length} +1,${added.length} @@`,
          ...removed.map((line) => `-${line}`),
          ...added.map((line) => `+${line}`),
        );
      }
      return { files: changed, meaningful, patch: patch.length === 0 ? "" : `${patch.join("\n")}\n` };
    },
  };
}

function lines(text: string): string[] {
  return text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
}

function squash(text: string): string {
  return text.replace(/\s+/g, "");
}
