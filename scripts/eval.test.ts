import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exitCode, formatReport, lineChangeCount, meetsBaseline, runEval } from "./eval.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("replay eval", () => {
  it("reports the gate pass rate and the diff budget", async () => {
    const report = await runEval(root);
    const baseline = JSON.parse(readFileSync(join(root, "evals", "baseline.json"), "utf8")) as {
      minPassRate: number;
    };
    const text = formatReport(report);

    expect(report.total).toBeGreaterThanOrEqual(10);
    expect(report.passed).toBe(8);
    expect(report.total).toBe(12);
    expect(report.passRate).toBe(baseline.minPassRate);
    expect(report.minPassRate).toBe(baseline.minPassRate);
    expect(report.meetsBaseline).toBe(true);
    expect(meetsBaseline(report.passed - 1, report.total, report.minPassRate)).toBe(false);
    expect(exitCode(report)).toBe(0);
    expect(exitCode({ ...report, meetsBaseline: false })).toBe(1);

    const byId = new Map(report.cases.map((item) => [item.id, item]));
    expect(byId.get("01-clamp-decrement")).toMatchObject({ gate: "pass", files: 1, lines: 2, withinBudget: true });
    expect(byId.get("02-thousands-separator")).toMatchObject({ gate: "pass", files: 1, lines: 2, withinBudget: true });
    expect(byId.get("09-failing-tests")?.gate).toBe("fail");
    expect(byId.get("10-empty-plan")?.gate).toBe("fail");
    expect(byId.get("11-wide-touch")).toMatchObject({ gate: "fail", files: 4, lines: 4, withinBudget: false });
    expect(byId.get("12-long-readme")?.gate).toBe("fail");
    expect(byId.get("12-long-readme")?.files).toBe(1);
    expect(byId.get("12-long-readme")?.withinBudget).toBe(false);
    expect(report.withinBudget).toBe(10);
    expect(report.files.min).toBeLessThanOrEqual(report.files.median);
    expect(report.files.median).toBeLessThanOrEqual(report.files.max);
    expect(text).toContain(`gate pass rate: ${report.passed}/${report.total}`);
    expect(text).toContain(`diff budget: ${report.budget.maxFiles} files, ${report.budget.maxLines} lines`);
    expect(text).toContain("11-wide-touch fail files 4 lines 4 over budget");
  });

  it("counts inserted and deleted lines", () => {
    expect(lineChangeCount("return value - 1;\n", "return Math.max(0, value - 1);\n")).toBe(2);
    expect(lineChangeCount("", "export function reset(): number {\n  return 0;\n}\n")).toBe(3);
    expect(lineChangeCount("same\n", "same\n")).toBe(0);
  });

  it("keeps the pass-rate check on the CI workflow", () => {
    const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("run: pnpm eval");
  });

  it("prints the report from pnpm eval", () => {
    const output = execFileSync("pnpm", ["eval"], { cwd: root, encoding: "utf8" });
    expect(output).toContain("gate pass rate: 8/12 (66.7%)");
    expect(output).toContain("baseline: 66.7%");
    expect(output).toContain("diff budget: 2 files, 16 lines");
    expect(output).toContain("within budget: 10/12");
  });
});
