import { describe, expect, it } from "vitest";
import { parsePatch } from "./diff";

const patch = [
  "diff --git a/src/counter.ts b/src/counter.ts",
  "index 3b18e51..a1c4f02 100644",
  "--- a/src/counter.ts",
  "+++ b/src/counter.ts",
  "@@ -4,3 +4,3 @@ export function increment(value: number): number {",
  " export function decrement(value: number): number {",
  "-  return value - 1;",
  "+  return Math.max(0, value - 1);",
  " }",
  "@@ -20,2 +20,2 @@",
  "--- a heading that starts with dashes",
  "+-- a heading that starts with dashes",
  " ",
  "diff --git a/src/reset.ts b/src/reset.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/reset.ts",
  "@@ -0,0 +1,2 @@",
  "+export const reset = (): number => 0;",
  "+",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parsePatch", () => {
  it("numbers old and new lines across hunks and files", () => {
    const files = parsePatch(patch);
    expect(files.map((file) => [file.path, file.status, file.hunks.length])).toEqual([
      ["src/counter.ts", "modified", 2],
      ["src/reset.ts", "added", 1],
    ]);

    const [first, second] = files[0]?.hunks ?? [];
    expect(first?.lines).toEqual([
      { kind: "context", text: "export function decrement(value: number): number {", oldLine: 4, newLine: 4 },
      { kind: "remove", text: "  return value - 1;", oldLine: 5, newLine: null },
      { kind: "add", text: "  return Math.max(0, value - 1);", oldLine: null, newLine: 5 },
      { kind: "context", text: "}", oldLine: 6, newLine: 6 },
    ]);
    expect(second?.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["remove", 20, null],
      ["add", null, 20],
      ["context", 21, 21],
    ]);
    expect(files[1]?.hunks[0]?.lines.map((line) => line.newLine)).toEqual([1, 2]);
  });

  it("returns no files for an empty patch", () => {
    expect(parsePatch("")).toEqual([]);
  });
});
