import { describe, expect, it } from "vitest";
import { confirmSources } from "./runner.js";

describe("runner file check", () => {
  it("parses the changed file bytes and ignores other files", () => {
    const before = "export function stub(): number {\n  return 0;\n}\n";
    const change = (path: string, after: string) => [{ path, before, after }];
    expect(confirmSources(change("src/stub.ts", "export function stub(): number {\n  return 1;\n}\n"))).toBe(true);
    expect(confirmSources(change("src/stub.ts", "export function stub( {\n"))).toBe(false);
    expect(confirmSources(change("README.md", "Notes ( {\n"))).toBe(true);
  });
});
