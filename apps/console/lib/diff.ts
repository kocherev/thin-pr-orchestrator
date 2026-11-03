export type DiffLine = {
  kind: "add" | "remove" | "context";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

export type DiffHunk = { header: string; lines: DiffLine[] };

export type DiffFile = {
  path: string;
  status: "added" | "deleted" | "modified";
  hunks: DiffHunk[];
};

const GIT_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DEV_NULL = "/dev/null";

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

/**
 * Parses a unified diff. Hunk line counts decide where a hunk ends, so a
 * removed line that starts with "--" is not mistaken for a file header.
 */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of patch.split("\n")) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === "+") {
        hunk.lines.push({ kind: "add", text, oldLine: null, newLine: newLine++ });
        newLeft--;
      } else if (marker === "-") {
        hunk.lines.push({ kind: "remove", text, oldLine: oldLine++, newLine: null });
        oldLeft--;
      } else if (marker !== "\\") {
        hunk.lines.push({ kind: "context", text, oldLine: oldLine++, newLine: newLine++ });
        oldLeft--;
        newLeft--;
      }
      continue;
    }

    const gitHeader = GIT_HEADER.exec(line);
    const hunkHeader = HUNK_HEADER.exec(line);
    if (gitHeader) {
      file = { path: gitHeader[2] ?? "", status: "modified", hunks: [] };
      files.push(file);
      hunk = undefined;
    } else if (line.startsWith("--- ")) {
      if (!file || file.hunks.length > 0) {
        file = { path: "", status: "modified", hunks: [] };
        files.push(file);
        hunk = undefined;
      }
      const path = line.slice(4).trim();
      if (path === DEV_NULL) file.status = "added";
      else if (!file.path) file.path = stripPrefix(path);
    } else if (line.startsWith("+++ ") && file) {
      const path = line.slice(4).trim();
      if (path === DEV_NULL) file.status = "deleted";
      else file.path = stripPrefix(path);
    } else if (hunkHeader && file) {
      oldLine = Number(hunkHeader[1]);
      oldLeft = hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2]);
      newLine = Number(hunkHeader[3]);
      newLeft = hunkHeader[4] === undefined ? 1 : Number(hunkHeader[4]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    }
  }
  return files;
}
