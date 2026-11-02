import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exitCode, formatJudgeReport, runJudge } from "./judge.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("judge eval", () => {
  it("scores the replayed runs against the rubric", { timeout: 240_000 }, async () => {
    const report = await runJudge(root, { THIN_PR_JUDGE: "replay", THIN_PR_MODEL: "replay" });
    const text = formatJudgeReport(report);
    const byId = new Map(report.cases.map((item) => [item.id, item]));

    expect(report.total).toBe(17);
    expect(report.passed).toBe(12);
    expect(report.meetsBaseline).toBe(true);
    expect(report.spentUsd).toBeNull();
    expect(exitCode(report)).toBe(0);
    expect(exitCode({ ...report, meetsBaseline: false })).toBe(1);
    expect(byId.get("01-clamp-decrement")?.verdict).toBe("pass");
    expect(byId.get("09-failing-hidden-test")?.reasons.find((reason) => reason.rule === "tests")?.reason).toBe(
      "Checks did not pass and the review has no notes.",
    );
    expect(byId.get("10-empty-plan")?.reasons.find((reason) => reason.rule === "plan")?.reason).toBe("Plan has no steps.");
    expect(byId.get("11-wide-touch")?.verdict).toBe("fail");
    // The rubric does not look at paths, secrets or whitespace, so it passes runs the gate blocks.
    expect(byId.get("15-planted-secret")?.verdict).toBe("pass");
    expect(text).toContain("judge pass rate: 12/17 (70.6%)");
    expect(text).toContain("baseline: 70.6%");
    expect(readFileSync(join(root, "docs/demo/judge-report.txt"), "utf8")).toBe(`${text}\n`);
  });

  it("keeps the recorded live judge run", () => {
    const text = readFileSync(join(root, "docs/demo/judge-live.txt"), "utf8");
    expect(text).toContain("judge pass rate: 9/12 (75.0%)");
    expect(text).toContain("live spend: 0.002965 USD");
    expect(text).toContain("09-failing-tests pass");
    expect(text).toContain("10-empty-plan fail");
    expect(text).toContain("11-wide-touch fail");
    expect(text).toContain("12-long-readme fail");
  });

  it("keeps the judge on the CI workflow", () => {
    const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("run: pnpm eval:judge");
  });
});
