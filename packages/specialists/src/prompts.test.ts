import { describe, expect, it } from "vitest";
import { implementerSystem, plannerSystem, PR_WRITER_SYSTEM, REVIEWER_SYSTEM } from "./prompts.js";

const FEATURE = { max_files: 12, max_lines: 600 };

describe("system prompts", () => {
  it("describe a repository and its configured checks, not a language or toolchain", () => {
    for (const prompt of [plannerSystem(FEATURE), implementerSystem(FEATURE), REVIEWER_SYSTEM, PR_WRITER_SYSTEM]) {
      expect(prompt).not.toMatch(/typescript|javascript|python|\btsc\b|vitest|pytest|npm|pnpm|node/i);
    }
    expect(implementerSystem(FEATURE)).toContain("run_check");
    expect(REVIEWER_SYSTEM).toContain("each configured check");
  });

  it("state the run's size limit instead of asking for a small change", () => {
    const limit = "The change may touch up to 12 files and 600 changed lines, counting added and removed lines.";
    for (const prompt of [plannerSystem(FEATURE), implementerSystem(FEATURE)]) {
      expect(prompt).toContain(limit);
      expect(prompt).toContain("A larger change waits for a person to approve it.");
      expect(prompt).not.toMatch(/small change|one to five steps|a few lines/);
    }
    expect(plannerSystem({ max_files: 1, max_lines: 1 })).toContain("up to 1 file and 1 changed line,");
  });
});
