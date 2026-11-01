import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decide,
  evaluate,
  measureDiff,
  packageId,
  readiness,
  type GateSubject,
  type RunnerEvidence,
} from "./index.js";

const passFixture = fileURLToPath(new URL("../../../fixtures/gate-pass.json", import.meta.url));
const failFixture = fileURLToPath(new URL("../../../fixtures/gate-fail.json", import.meta.url));

describe("@thin-pr/gate", () => {
  it("evaluates the pass fixture as PASS for every rule", () => {
    expect(packageId).toBe("@thin-pr/gate");
    expect(readiness()).toBe("ready");

    const subject = readSubject(passFixture);
    const diff = measureDiff([
      {
        path: "src/stub.ts",
        before: "export function stub(): number {\n  return 0;\n}\n",
        after: "export function stub(): number {\n  return 1;\n}\n",
      },
    ]);
    const runner = evidence(diff, true);
    expect(evaluate(subject, runner)).toEqual([
      { rule: "plan", verdict: "PASS", reason: "Plan is present (1 step)." },
      { rule: "tests", verdict: "PASS", reason: "Tests passed." },
      { rule: "contracts", verdict: "PASS", reason: "Specialist outputs match their contracts." },
      { rule: "diff", verdict: "PASS", reason: "Diff is present (1 file, 2 lines)." },
      { rule: "budget", verdict: "PASS", reason: "Diff is within the budget (1 file, 2 lines; limit 2 files, 16 lines)." },
    ]);
    expect(decide(subject, runner)).toBe("pass");
    expect(decide()).toBe("pass");
    expect(decide(subject)).toBe("fail");
  });

  it("fails the tests rule when the tester contract says the run did not pass", () => {
    const subject = readSubject(failFixture);
    const diff = measureDiff([
      { path: "src/stub.ts", before: "export const value = 0;\n", after: "export const value = 1;\n" },
    ]);
    expect(evaluate(subject, evidence(diff, true)).find((result) => result.rule === "tests")).toEqual({
      rule: "tests",
      verdict: "FAIL",
      reason: "Tests did not pass.",
    });
    expect(decide(subject, evidence(diff, true))).toBe("fail");
  });

  it("fails an empty or whitespace diff even when the model listed files and passed tests", () => {
    const subject = readSubject(passFixture);
    const empty = measureDiff([{ path: "src/stub.ts", before: "export const stub = 1;\n", after: "export const stub = 1;\n" }]);
    expect(empty).toEqual({ files: 0, lines: 0, meaningful: false });
    expect(evaluate(subject, evidence(empty, true)).find((result) => result.rule === "diff")).toEqual({
      rule: "diff",
      verdict: "FAIL",
      reason: "Diff is empty.",
    });

    const spaces = measureDiff([
      { path: "src/stub.ts", before: "export const stub = 1;\n", after: "export const stub = 1;  \n" },
    ]);
    expect(spaces.meaningful).toBe(false);
    expect(evaluate(subject, evidence(spaces, true)).find((result) => result.rule === "diff")?.reason).toBe(
      "Diff has no meaningful change.",
    );
    expect(decide(subject, evidence(spaces, true))).toBe("fail");
  });

  it("fails the budget from the measured diff, not from the model file list", () => {
    const subject = readSubject(passFixture);
    const before = "export const stub = 1;\n";
    const after = `${before}${Array.from({ length: 20 }, (_, index) => `export const extra${index} = ${index};\n`).join("")}`;
    const diff = measureDiff([{ path: "src/stub.ts", before, after }]);
    expect(diff.files).toBe(1);
    expect(diff.lines).toBeGreaterThan(16);
    expect(evaluate(subject, evidence(diff, true)).find((result) => result.rule === "budget")?.verdict).toBe("FAIL");
  });

  it("does not let a passing model flag override a failed runner check", () => {
    const subject = readSubject(passFixture);
    const diff = measureDiff([
      { path: "src/stub.ts", before: "export const stub = 1;\n", after: "export const stub = 2;\n" },
    ]);
    expect(evaluate(subject, evidence(diff, false)).find((result) => result.rule === "tests")).toEqual({
      rule: "tests",
      verdict: "FAIL",
      reason: "Runner did not confirm the tests.",
    });
  });

  it("fails a rule when a specialist output does not match its contract", () => {
    const subject = { ...readSubject(passFixture), review: { summary: "ok", notes: [1] } };
    expect(evaluate(subject).find((result) => result.rule === "contracts")).toEqual({
      rule: "contracts",
      verdict: "FAIL",
      reason: "review output does not match its contract.",
    });
    expect(evaluate({ ...readSubject(passFixture), plan: { summary: "" } })[0]).toEqual({
      rule: "plan",
      verdict: "FAIL",
      reason: "Plan output does not match its contract.",
    });
  });

  it("fails plan and contracts when the plan output is missing", () => {
    const subject = { ...readSubject(passFixture), plan: null };
    const diff = measureDiff([
      { path: "src/stub.ts", before: "export const value = 0;\n", after: "export const value = 1;\n" },
    ]);
    expect(evaluate(subject, evidence(diff, true)).map((result) => [result.rule, result.verdict, result.reason])).toEqual([
      ["plan", "FAIL", "Plan is missing."],
      ["tests", "PASS", "Tests passed."],
      ["contracts", "FAIL", "Missing plan output."],
      ["diff", "PASS", "Diff is present (1 file, 2 lines)."],
      ["budget", "PASS", "Diff is within the budget (1 file, 2 lines; limit 2 files, 16 lines)."],
    ]);
  });
});

function readSubject(path: string): GateSubject {
  return JSON.parse(readFileSync(path, "utf8")) as GateSubject;
}

function evidence(diff: RunnerEvidence["diff"], testsPassed: boolean): RunnerEvidence {
  return { diff, testsPassed, budget: { maxFiles: 2, maxLines: 16 } };
}
