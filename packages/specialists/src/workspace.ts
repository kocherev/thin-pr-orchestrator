/** The checkout a run edits and checks. The only seam the implementations meet on. */
export interface Workspace {
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<string | null>;
  search(pattern: string): Promise<{ path: string; line: number; text: string }[]>;
  replace(path: string, oldText: string, newText: string): Promise<void>; // oldText must match exactly once
  createFile(path: string, content: string): Promise<void>; // fails if it exists
  runCheck(name: "typecheck" | "test"): Promise<CheckResult>;
  /** The commands `.thin-pr.yml` lists under `generate`, such as a code generator. Usually none. */
  readonly generators: readonly string[];
  /** Runs one of `generators` like a check. Rejects any other command. */
  runGenerator(command: string): Promise<GeneratorResult>;
  diff(): Promise<Diff>;
}

export type GeneratorResult = { command: string; exitCode: number; durationMs: number; logTail: string };

export type CheckResult = { name: "typecheck" | "test"; command: string; exitCode: number; durationMs: number; logTail: string };

export type Diff = { files: { path: string; added: number; removed: number }[]; meaningful: boolean; patch: string };
