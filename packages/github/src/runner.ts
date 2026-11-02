import type { StepHandler } from "@thin-pr/core";
import type { FileChange } from "@thin-pr/gate";
import ts from "typescript";

const CODE = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

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
