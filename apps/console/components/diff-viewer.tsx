import { parsePatch, type DiffFile, type DiffLine } from "@/lib/diff";
import type { Diff } from "@/lib/schema";
import { Badge } from "./ui/badge";

const LINE_STYLE: Record<DiffLine["kind"], { marker: string; row: string }> = {
  add: { marker: "+", row: "bg-diff-add" },
  remove: { marker: "-", row: "bg-diff-remove" },
  context: { marker: " ", row: "" },
};

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono text-xs tabular-nums">
      <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
    </span>
  );
}

function FileDiff({ file }: { file: DiffFile }) {
  const lines = file.hunks.flatMap((hunk) => hunk.lines);
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-4 py-2">
        <span className="min-w-0 truncate font-mono text-xs font-medium">{file.path}</span>
        {file.status !== "modified" ? <Badge tone="neutral">{file.status === "added" ? "new file" : "deleted"}</Badge> : null}
        <span className="ml-auto">
          <Counts
            added={lines.filter((line) => line.kind === "add").length}
            removed={lines.filter((line) => line.kind === "remove").length}
          />
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <caption className="sr-only">Changes to {file.path}</caption>
          {file.hunks.map((hunk, index) => (
            <tbody key={`${hunk.header}-${index}`}>
              <tr className="bg-primary/6 text-muted-foreground">
                <td colSpan={4} className="px-4 py-1 whitespace-pre">
                  {hunk.header}
                </td>
              </tr>
              {hunk.lines.map((line, lineIndex) => {
                const style = LINE_STYLE[line.kind];
                return (
                  <tr key={lineIndex} className={style.row}>
                    <td className="w-10 pr-2 pl-4 text-right text-muted-foreground/80 tabular-nums select-none">{line.oldLine}</td>
                    <td className="w-10 pr-2 text-right text-muted-foreground/80 tabular-nums select-none">{line.newLine}</td>
                    <td className="w-4 text-muted-foreground select-none">{style.marker}</td>
                    <td className="pr-4 whitespace-pre">{line.text}</td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}

export function DiffSummary({ diff }: { diff: Diff }) {
  const added = diff.files.reduce((sum, file) => sum + file.added, 0);
  const removed = diff.files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <span className="inline-flex items-center gap-2">
      {diff.files.length} {diff.files.length === 1 ? "file" : "files"} changed <Counts added={added} removed={removed} />
    </span>
  );
}

export function DiffViewer({ diff }: { diff: Diff }) {
  return (
    <div>
      {!diff.meaningful ? (
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">Whitespace-only change.</p>
      ) : null}
      {parsePatch(diff.patch).map((file) => (
        <FileDiff key={file.path} file={file} />
      ))}
    </div>
  );
}
