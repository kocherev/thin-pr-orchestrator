import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decide, evaluate, packageId, readiness, type GateSubject } from "./index.js";

const passFixture = fileURLToPath(new URL("../../../fixtures/gate-pass.json", import.meta.url));
const failFixture = fileURLToPath(new URL("../../../fixtures/gate-fail.json", import.meta.url));

describe("@thin-pr/gate", () => {
  it("evaluates the pass fixture as PASS for every rule", () => {
    expect(packageId).toBe("@thin-pr/gate");
    expect(readiness()).toBe("ready");

    const subject = readSubject(passFixture);
    expect(evaluate(subject)).toEqual([
      { rule: "plan", verdict: "PASS", reason: "Plan is present (1 step)." },
      { rule: "tests", verdict: "PASS", reason: "Tests passed." },
      { rule: "contracts", verdict: "PASS", reason: "Specialist outputs match their contracts." },
    ]);
    expect(decide(subject)).toBe("pass");
    expect(decide()).toBe("pass");
  });

  it("fails the tests rule when the tester contract says the run did not pass", () => {
    const subject = readSubject(failFixture);
    expect(evaluate(subject)).toEqual([
      { rule: "plan", verdict: "PASS", reason: "Plan is present (1 step)." },
      { rule: "tests", verdict: "FAIL", reason: "Tests did not pass." },
      { rule: "contracts", verdict: "PASS", reason: "Specialist outputs match their contracts." },
    ]);
    expect(decide(subject)).toBe("fail");
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
    expect(evaluate(subject).map((result) => [result.rule, result.verdict, result.reason])).toEqual([
      ["plan", "FAIL", "Plan is missing."],
      ["tests", "PASS", "Tests passed."],
      ["contracts", "FAIL", "Missing plan output."],
    ]);
  });
});

function readSubject(path: string): GateSubject {
  return JSON.parse(readFileSync(path, "utf8")) as GateSubject;
}
