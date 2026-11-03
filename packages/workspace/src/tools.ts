import type { Workspace } from "@thin-pr/specialists";
import type { RepoConfig } from "./config.js";
import { classifyPath, repoPath } from "./paths.js";

/** Where the files live. Paths are already checked with `repoPath`. */
export type FileStore = {
  list(): Promise<string[]>;
  read(path: string): Promise<string | null>;
  write(path: string, content: string, mode: "create" | "overwrite"): Promise<void>;
};

const MAX_SEARCH_RESULTS = 50;

/** The file half of a workspace: the same rules over a git checkout or an in-memory tree. */
export function fileTools(
  store: FileStore,
  paths: RepoConfig["paths"],
): Pick<Workspace, "listFiles" | "readFile" | "search" | "replace" | "createFile"> {
  // The tool runner runs a turn's tool calls at once, so two edits to one file would read the same original
  // and the second write would drop the first. Edits run one at a time.
  let edits: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(edit: () => Promise<T>): Promise<T> => {
    const done = edits.then(edit);
    edits = done.catch(() => undefined);
    return done;
  };

  return {
    listFiles: () => store.list(),
    readFile: async (path) => store.read(repoPath(path)),
    async search(pattern) {
      const matches = matcher(pattern);
      const results: { path: string; line: number; text: string }[] = [];
      for (const path of await store.list()) {
        const lines = (await store.read(path))?.split("\n") ?? [];
        for (const [index, text] of lines.entries()) {
          if (matches(text)) {
            results.push({ path, line: index + 1, text });
            if (results.length === MAX_SEARCH_RESULTS) {
              return results;
            }
          }
        }
      }
      return results;
    },
    replace: (path, oldText, newText) => inTurn(async () => {
      const target = repoPath(path);
      const content = await store.read(target);
      if (content === null) {
        throw new Error(`replace: ${target} does not exist`);
      }
      if (oldText.length === 0) {
        throw new Error("replace: oldText is empty");
      }
      const count = content.split(oldText).length - 1;
      if (count !== 1) {
        throw new Error(`replace: oldText matches ${count} times in ${target}; it must match exactly once`);
      }
      await store.write(target, content.replace(oldText, () => newText), "overwrite");
    }),
    createFile: (path, content) => inTurn(async () => {
      const target = repoPath(path);
      const verdict = classifyPath(paths, target);
      if (verdict !== "allowed") {
        throw new Error(`createFile: ${target} ${verdict === "denied" ? "matches a denied path" : "is outside the allowed paths"}`);
      }
      if ((await store.read(target)) !== null) {
        throw new Error(`createFile: ${target} already exists`);
      }
      await store.write(target, content, "create");
    }),
  };
}

// The pattern is a regular expression when it compiles, and a fixed string otherwise.
function matcher(pattern: string): (line: string) => boolean {
  try {
    const regex = new RegExp(pattern);
    return (line) => regex.test(line);
  } catch {
    return (line) => line.includes(pattern);
  }
}
