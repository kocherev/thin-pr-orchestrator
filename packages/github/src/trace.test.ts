import { describe, expect, it } from "vitest";
import { combineTraceExports, spanNames } from "./trace.js";

describe("trace export", () => {
  it("merges OTLP JSON bodies and lists span names", () => {
    const body = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [{ spans: [{ name: "thin-pr.plan" }, { name: "thin-pr.run" }] }],
        },
      ],
    });
    const merged = combineTraceExports([body, " \n", body]);
    expect(spanNames(JSON.parse(merged) as unknown)).toEqual([
      "thin-pr.plan",
      "thin-pr.run",
      "thin-pr.plan",
      "thin-pr.run",
    ]);
    expect(merged.endsWith("\n")).toBe(true);
    expect(() => combineTraceExports([" "])).toThrow("trace export was empty");
    expect(() => combineTraceExports(["{}"])).toThrow("trace export has no resourceSpans");
  });
});
