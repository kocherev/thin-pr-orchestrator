import { fileURLToPath } from "node:url";
import type { CheckResult, Diff } from "@thin-pr/specialists";
import { loadRepoConfig } from "@thin-pr/workspace";
import { describe, expect, it } from "vitest";
import { decide, decideResults, evaluate, GATE_RULES, type RunEvidence } from "./index.js";

// This directory has no .thin-pr.yml, so it gives the default config.
const config = loadRepoConfig(fileURLToPath(new URL(".", import.meta.url)));

const twoLines: Diff = {
  files: [{ path: "src/counter.ts", added: 1, removed: 1 }],
  meaningful: true,
  patch: ["--- a/src/counter.ts", "+++ b/src/counter.ts", "@@ -1 +1 @@", "-  return value - 1;", "+  return Math.max(0, value - 1);", ""].join(
    "\n",
  ),
};

describe("evaluate", () => {
  it("passes a clean run on every rule, in order", () => {
    expect(evaluate(evidence({}))).toEqual([
      { rule: "plan", verdict: "PASS", reason: "Plan is present (1 step)." },
      { rule: "contracts", verdict: "PASS", reason: "Step outputs match their contracts." },
      { rule: "diff", verdict: "PASS", reason: "Diff is present (1 file, 2 lines)." },
      { rule: "budget", verdict: "PASS", reason: "Diff is within the budget (1 file, 2 lines; limit 2 files, 16 lines)." },
      { rule: "paths", verdict: "PASS", reason: "Every changed path is allowed." },
      { rule: "secrets", verdict: "PASS", reason: "No added line looks like a secret." },
      { rule: "typecheck", verdict: "PASS", reason: "Typecheck passed: tsc --noEmit" },
      { rule: "tests", verdict: "PASS", reason: "Tests passed: vitest run" },
      { rule: "review", verdict: "PASS", reason: "Reviewer approved." },
    ]);
    expect(evaluate(evidence({})).map((result) => result.rule)).toEqual([...GATE_RULES]);
    expect(decide(evidence({}))).toBe("pass");
  });

  it("fails plan when it is missing or breaks the planner contract", () => {
    expect(reason({ plan: undefined }, "plan")).toBe("FAIL: Plan is missing.");
    expect(reason({ plan: { summary: "Rename.", steps: [] } }, "plan")).toBe("FAIL: Plan output does not match its contract.");
  });

  it("fails contracts on the first invalid step output", () => {
    const contracts = [
      { step: "plan", valid: true },
      { step: "review", valid: false },
      { step: "write", valid: false },
    ];
    expect(reason({ contracts }, "contracts")).toBe("FAIL: review output does not match its contract.");
    expect(reason({ contracts: [] }, "contracts")).toBe("FAIL: No step output was checked.");
  });

  it("fails diff when it is missing, empty, or only whitespace", () => {
    expect(reason({ diff: null }, "diff")).toBe("FAIL: Diff was not measured.");
    expect(reason({ diff: { files: [], meaningful: false, patch: "" } }, "diff")).toBe("FAIL: Diff is empty.");
    expect(reason({ diff: { ...twoLines, meaningful: false } }, "diff")).toBe("FAIL: Diff only changes whitespace.");
  });

  it("asks for approval when only the budget is over: too many files or too many lines", () => {
    const files = (count: number, lines: number): Diff => ({
      files: Array.from({ length: count }, (_, index) => ({ path: `src/f${index}.ts`, added: lines, removed: 0 })),
      meaningful: true,
      patch: "",
    });
    expect(reason({ diff: files(3, 1) }, "budget")).toBe(
      "NEEDS_APPROVAL: Diff exceeds the budget (3 files, 3 lines; limit 2 files, 16 lines).",
    );
    expect(reason({ diff: files(1, 17) }, "budget")).toBe(
      "NEEDS_APPROVAL: Diff exceeds the budget (1 file, 17 lines; limit 2 files, 16 lines).",
    );
    expect(decide(evidence({ diff: files(1, 17) }))).toBe("needs_approval");
    expect(reason({ diff: files(2, 8) }, "budget")).toMatch(/^PASS/);
    expect(reason({ diff: files(13, 1), budget: { max_files: 12, max_lines: 600 } }, "budget")).toMatch(/^NEEDS_APPROVAL/);
    expect(reason({ diff: files(12, 50), budget: { max_files: 12, max_lines: 600 } }, "budget")).toMatch(/^PASS/);
  });

  it("fails an over-size diff when another rule fails, and leaves an empty diff to the diff rule", () => {
    const wide: Diff = { ...twoLines, files: [{ path: "src/counter.ts", added: 30, removed: 0 }] };
    const failing = evidence({ diff: wide, checks: [check("typecheck", 0), check("test", 1)] });
    expect(evaluate(failing).find((result) => result.rule === "budget")).toEqual({
      rule: "budget",
      verdict: "FAIL",
      reason: "Diff exceeds the budget (1 file, 30 lines; limit 2 files, 16 lines).",
    });
    expect(decide(failing)).toBe("fail");
    expect(reason({ diff: null }, "budget")).toBe("FAIL: Budget was not measured.");
    const empty = evidence({ diff: { files: [], meaningful: false, patch: "" } });
    expect(evaluate(empty).filter((result) => result.verdict !== "PASS").map((result) => result.rule)).toEqual(["diff"]);
  });

  it("decides stored results: any FAIL fails, else NEEDS_APPROVAL waits, else it passes", () => {
    const results = evaluate(evidence({}));
    expect(decideResults(results)).toBe("pass");
    const over = results.map((result) => (result.rule === "budget" ? { ...result, verdict: "NEEDS_APPROVAL" as const } : result));
    expect(decideResults(over)).toBe("needs_approval");
    expect(decideResults(over.map((result) => (result.rule === "tests" ? { ...result, verdict: "FAIL" as const } : result)))).toBe("fail");
    expect(decideResults([])).toBe("fail");
  });

  it("fails paths when a changed file is denied or outside allow", () => {
    const diff: Diff = {
      ...twoLines,
      files: [
        { path: "src/counter.ts", added: 1, removed: 1 },
        { path: ".github/workflows/ci.yml", added: 1, removed: 0 },
        { path: "package.json", added: 1, removed: 0 },
      ],
    };
    expect(reason({ diff }, "paths")).toBe(
      "FAIL: Changed paths are not allowed: .github/workflows/ci.yml (denied), package.json (not in allow).",
    );
  });

  it("fails secrets with the file and line and without the value", () => {
    const value = ["gh", "p_", "Q".repeat(36)].join("");
    const diff: Diff = {
      files: [{ path: "src/client.ts", added: 2, removed: 0 }],
      meaningful: true,
      patch: ["--- /dev/null", "+++ b/src/client.ts", "@@ -0,0 +1,2 @@", "+// GitHub client", `+const auth = "${value}";`, ""].join("\n"),
    };
    const result = reason({ diff }, "secrets");
    expect(result).toBe("FAIL: Added lines look like secrets: src/client.ts:2 (GitHub token).");
    expect(result).not.toContain(value.slice(4));
  });

  it("fails typecheck and tests when the check failed or did not run", () => {
    const failing = [check("typecheck", 2), check("test", 1)];
    expect(reason({ checks: failing }, "typecheck")).toBe("FAIL: Typecheck failed (exit 2): tsc --noEmit");
    expect(reason({ checks: failing }, "tests")).toBe("FAIL: Tests failed (exit 1): vitest run");
    expect(reason({ checks: [] }, "typecheck")).toBe("FAIL: Typecheck did not run.");
    expect(reason({ checks: [] }, "tests")).toBe("FAIL: Tests did not run.");
  });

  it("follows the reviewer verdict, not the number of notes", () => {
    expect(reason({ review: { summary: "Looks fine.", verdict: "approve", notes: ["Nit."] } }, "review")).toBe(
      "PASS: Reviewer approved.",
    );
    const changes = { summary: "Clamp the helper.", verdict: "changes_requested", notes: ["decrementBy goes below zero."] };
    expect(reason({ review: changes }, "review")).toBe("FAIL: Reviewer requested changes (1 note).");
    expect(reason({ review: { summary: "Clamp the helper.", notes: ["decrementBy goes below zero."] } }, "review")).toBe(
      "FAIL: Review output does not match its contract.",
    );
    expect(reason({ review: undefined }, "review")).toBe("FAIL: Review is missing.");
    expect(reason({ review: { summary: "", notes: [] } }, "review")).toBe("FAIL: Review output does not match its contract.");
  });

  it("fails the decision when any one rule fails", () => {
    expect(decide(evidence({ checks: [check("typecheck", 0), check("test", 1)] }))).toBe("fail");
  });
});

function evidence(overrides: Partial<RunEvidence>): RunEvidence {
  return {
    plan: { summary: "Clamp decrement.", steps: ["Change decrement in src/counter.ts"] },
    review: { summary: "The clamp matches the issue.", verdict: "approve", notes: [] },
    contracts: ["plan", "implement", "verify", "review", "write"].map((step) => ({ step, valid: true })),
    diff: twoLines,
    checks: [check("typecheck", 0), check("test", 0)],
    budget: { max_files: 2, max_lines: 16 },
    config,
    ...overrides,
  };
}

function check(name: CheckResult["name"], exitCode: number): CheckResult {
  return { name, command: name === "typecheck" ? "tsc --noEmit" : "vitest run", exitCode, durationMs: 300, logTail: "" };
}

function reason(overrides: Partial<RunEvidence>, rule: (typeof GATE_RULES)[number]): string {
  const result = evaluate(evidence(overrides)).find((item) => item.rule === rule);
  return `${result?.verdict}: ${result?.reason}`;
}
