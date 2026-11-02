import { describe, expect, it } from "vitest";
import { decide, evaluate, measureDiff, type DiffMeasurement, type RunEvidence } from "./index.js";

const outputs = {
  plan: { summary: "Plan the stub change.", steps: ["edit the stub"] },
  implement: { summary: "Apply the stub change.", files: ["src/stub.ts"] },
  verify: { summary: "Stub checks passed.", passed: true, sourcesParse: true },
  review: { summary: "Stub review found nothing.", notes: [] },
  write: { summary: "pass", title: "Fix the stub", body: "Stub draft." },
};

const twoLines = measureDiff([
  {
    path: "src/stub.ts",
    before: "export function stub(): number {\n  return 0;\n}\n",
    after: "export function stub(): number {\n  return 1;\n}\n",
  },
]);

describe("@thin-pr/gate", () => {
  it("evaluates a clean run as PASS for every rule", () => {
    const run = evidence({}, twoLines);
    expect(evaluate(run)).toEqual([
      { rule: "plan", verdict: "PASS", reason: "Plan is present (1 step)." },
      { rule: "tests", verdict: "PASS", reason: "Tests passed." },
      { rule: "contracts", verdict: "PASS", reason: "Specialist outputs match their contracts." },
      { rule: "diff", verdict: "PASS", reason: "Diff is present (1 file, 2 lines)." },
      { rule: "budget", verdict: "PASS", reason: "Diff is within the budget (1 file, 2 lines; limit 2 files, 16 lines)." },
    ]);
    expect(decide(run)).toBe("pass");
    expect(decide(evidence({}, null))).toBe("fail");
  });

  it("fails the tests rule when the recorded verdict did not pass", () => {
    const run = evidence({ verify: { ...outputs.verify, summary: "Stub checks failed.", passed: false } }, twoLines);
    expect(rule(run, "tests")).toEqual({ rule: "tests", verdict: "FAIL", reason: "Tests did not pass." });
    expect(decide(run)).toBe("fail");
  });

  it("does not let a passing verdict override a source that does not parse", () => {
    const run = evidence({ verify: { ...outputs.verify, sourcesParse: false } }, twoLines);
    expect(rule(run, "tests")?.reason).toBe("Runner did not confirm the tests.");
  });

  it("fails an empty or whitespace diff even when the model listed files and passed tests", () => {
    const empty = measureDiff([{ path: "src/stub.ts", before: "export const stub = 1;\n", after: "export const stub = 1;\n" }]);
    expect(empty).toEqual({ files: 0, lines: 0, meaningful: false });
    expect(rule(evidence({}, empty), "diff")?.reason).toBe("Diff is empty.");
    expect(rule(evidence({}, empty), "tests")?.reason).toBe("Runner did not confirm the tests.");

    const spaces = measureDiff([
      { path: "src/stub.ts", before: "export const stub = 1;\n", after: "export const stub = 1;  \n" },
    ]);
    expect(spaces.meaningful).toBe(false);
    expect(rule(evidence({}, spaces), "diff")?.reason).toBe("Diff has no meaningful change.");
  });

  it("fails the budget from the measured diff, not from the model file list", () => {
    const before = "export const stub = 1;\n";
    const after = `${before}${Array.from({ length: 20 }, (_, index) => `export const extra${index} = ${index};\n`).join("")}`;
    const diff = measureDiff([{ path: "src/stub.ts", before, after }]);
    expect(diff).toEqual({ files: 1, lines: 20, meaningful: true });
    expect(rule(evidence({}, diff), "budget")?.verdict).toBe("FAIL");
  });

  it("counts inserted and deleted lines", () => {
    const lines = (before: string, after: string) => measureDiff([{ path: "src/a.ts", before, after }]).lines;
    expect(lines("return value - 1;\n", "return Math.max(0, value - 1);\n")).toBe(2);
    expect(lines("", "export function reset(): number {\n  return 0;\n}\n")).toBe(3);
    expect(lines("same\n", "same\n")).toBe(0);
  });

  it("fails a rule when a step output does not match its contract", () => {
    expect(rule(evidence({ review: { summary: "ok", notes: [1] } }, twoLines), "contracts")).toEqual({
      rule: "contracts",
      verdict: "FAIL",
      reason: "review output does not match its contract.",
    });
    expect(rule(evidence({ plan: { summary: "" } }, twoLines), "plan")?.reason).toBe(
      "Plan output does not match its contract.",
    );
  });

  it("fails plan and contracts when the plan output is missing", () => {
    const results = evaluate(evidence({ plan: undefined }, twoLines));
    expect(results.map((result) => [result.rule, result.verdict, result.reason])).toEqual([
      ["plan", "FAIL", "Plan is missing."],
      ["tests", "PASS", "Tests passed."],
      ["contracts", "FAIL", "Missing plan output."],
      ["diff", "PASS", "Diff is present (1 file, 2 lines)."],
      ["budget", "PASS", "Diff is within the budget (1 file, 2 lines; limit 2 files, 16 lines)."],
    ]);
  });

  it("fails the diff and budget rules when nothing was measured", () => {
    const failed = evaluate(evidence({}, null)).filter((result) => result.verdict === "FAIL");
    expect(failed.map((result) => result.reason)).toEqual([
      "Runner did not confirm the tests.",
      "Diff was not measured.",
      "Budget was not measured.",
    ]);
  });
});

function evidence(overrides: Partial<Record<keyof typeof outputs, unknown>>, diff: DiffMeasurement | null): RunEvidence {
  return { outputs: { ...outputs, ...overrides }, diff, budget: { maxFiles: 2, maxLines: 16 } };
}

function rule(run: RunEvidence, name: string) {
  return evaluate(run).find((result) => result.rule === name);
}
