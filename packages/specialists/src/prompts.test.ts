import { describe, expect, it } from "vitest";
import { IMPLEMENTER_SYSTEM, PLANNER_SYSTEM, PR_WRITER_SYSTEM, REVIEWER_SYSTEM } from "./prompts.js";

describe("system prompts", () => {
  it("describe a repository and its configured checks, not a language or toolchain", () => {
    for (const prompt of [PLANNER_SYSTEM, IMPLEMENTER_SYSTEM, REVIEWER_SYSTEM, PR_WRITER_SYSTEM]) {
      expect(prompt).not.toMatch(/typescript|javascript|python|\btsc\b|vitest|pytest|npm|pnpm|node/i);
    }
    expect(IMPLEMENTER_SYSTEM).toContain("run_check");
    expect(REVIEWER_SYSTEM).toContain("each configured check");
  });
});
