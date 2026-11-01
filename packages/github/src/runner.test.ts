import { describe, expect, it } from "vitest";
import { confirmSources } from "./runner.js";

describe("runner file check", () => {
  it("parses the file bytes and ignores any model flag", () => {
    const source = "export function stub(): number {\n  return 1;\n}\n";
    expect(confirmSources([{ path: "src/stub.ts", source }])).toBe(true);
    expect(confirmSources([{ path: "src/stub.ts", source: "export function stub( {\n" }])).toBe(false);
    expect(confirmSources([{ path: "README.md", source: "Notes\n" }])).toBe(true);
  });
});