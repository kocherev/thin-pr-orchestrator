import { describe, expect, it } from "vitest";
import { spanNames } from "./trace.js";

describe("trace export", () => {
  it("lists span names across resources and scopes", () => {
    const document = {
      resourceSpans: [
        { scopeSpans: [{ spans: [{ name: "thin-pr.plan" }, { name: "thin-pr.run" }] }] },
        { scopeSpans: [{ spans: [{ name: "anthropic.messages.create" }] }] },
      ],
    };
    expect(spanNames(document)).toEqual(["thin-pr.plan", "thin-pr.run", "anthropic.messages.create"]);
    expect(() => spanNames({})).toThrow("trace export invalid at resourceSpans");
  });
});
