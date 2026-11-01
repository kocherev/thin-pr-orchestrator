import ts from "typescript";

const CODE = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

export function confirmSources(files: readonly { readonly path: string; readonly source: string }[]): boolean {
  for (const file of files) {
    const extension = file.path.includes(".") ? file.path.slice(file.path.lastIndexOf(".")) : "";
    if (!CODE.has(extension)) {
      continue;
    }
    if (!safeRelative(file.path)) {
      throw new Error(`check path escapes the tree: ${file.path}`);
    }
    const parsed = ts.transpileModule(file.source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
      fileName: file.path,
    });
    if ((parsed.diagnostics ?? []).some((item) => item.category === ts.DiagnosticCategory.Error)) {
      return false;
    }
  }
  return true;
}

function safeRelative(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
}
