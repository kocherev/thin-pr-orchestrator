/** The checkout a run edits and checks. The only seam the implementations meet on. */
export interface Workspace {
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<string | null>;
  search(pattern: string): Promise<{ path: string; line: number; text: string }[]>;
  replace(path: string, oldText: string, newText: string): Promise<void>; // oldText must match exactly once
  createFile(path: string, content: string): Promise<void>; // fails if it exists
  runCheck(name: "typecheck" | "test"): Promise<CheckResult>;
  diff(): Promise<Diff>;
}

export type CheckResult = { name: "typecheck" | "test"; command: string; exitCode: number; durationMs: number; logTail: string };

export type Diff = { files: { path: string; added: number; removed: number }[]; meaningful: boolean; patch: string };
