import type { Json, StepHandler } from "@thin-pr/core";
import type { BudgetLimits, DiffMeasurement, FileChange } from "@thin-pr/gate";
import { implementerOutput } from "@thin-pr/specialists";
import ts from "typescript";
import type { GitHubSurface } from "./surface.js";

const CODE = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

type Target = { readonly owner: string; readonly repo: string };

/** Reads the base bytes of every file the implementer edited. The model's file list is not used. */
export async function collectChanges(
  github: GitHubSurface,
  target: Target,
  baseSha: string,
  output: Json | null,
): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  for (const edit of implementerOutput.safeParse(output).data?.edits ?? []) {
    if (edit.path.length === 0 || edit.path.startsWith("/") || edit.path.split(/[\\/]/).includes("..")) {
      throw new Error(`edit path escapes the tree: ${edit.path}`);
    }
    const before = await github.readText({ ...target, ref: baseSha, path: edit.path });
    changes.push({ path: edit.path, before: before ?? "", after: edit.content });
  }
  return changes;
}

/** Commits the measured change when it is meaningful and inside the budget. Returns the new head, or null. */
export async function commitChanges(
  github: GitHubSurface,
  target: Target,
  commit: { readonly branch: string; readonly parentSha: string; readonly message: string },
  changes: readonly FileChange[],
  diff: DiffMeasurement,
  budget: BudgetLimits,
): Promise<string | null> {
  if (!diff.meaningful || diff.files > budget.maxFiles || diff.lines > budget.maxLines) {
    return null;
  }
  return github.commitFiles({
    ...target,
    ...commit,
    files: changes
      .filter((change) => change.before !== change.after)
      .map((change) => ({ path: change.path, content: change.after })),
  });
}

/** The verify step: the recorded tester verdict plus a parse of every changed source file. */
export function withSourceCheck(verify: StepHandler, changes: () => readonly FileChange[]): StepHandler {
  return async (context) => {
    const result = await verify(context);
    const output = result.output;
    if (typeof output !== "object" || output === null || Array.isArray(output)) {
      throw new Error("verify output must be an object");
    }
    return { ...result, output: { ...output, sourcesParse: confirmSources(changes()) } };
  };
}

export function confirmSources(changes: readonly FileChange[]): boolean {
  for (const change of changes) {
    const extension = change.path.includes(".") ? change.path.slice(change.path.lastIndexOf(".")) : "";
    if (change.before === change.after || !CODE.has(extension)) {
      continue;
    }
    const parsed = ts.transpileModule(change.after, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
      fileName: change.path,
    });
    if ((parsed.diagnostics ?? []).some((item) => item.category === ts.DiagnosticCategory.Error)) {
      return false;
    }
  }
  return true;
}
