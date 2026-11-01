import { z } from "zod";
import { AnthropicModelClient } from "./live.js";
import { implementerOutput, plannerOutput, reviewerOutput, testerOutput } from "./specialists.js";

export const JUDGE_RULES = ["plan", "files", "tests", "review"] as const;

export type JudgeRule = (typeof JUDGE_RULES)[number];

export type JudgeReason = {
  readonly rule: JudgeRule;
  readonly verdict: "pass" | "fail";
  readonly reason: string;
};

export type JudgeVerdict = {
  readonly verdict: "pass" | "fail";
  readonly reasons: readonly JudgeReason[];
};

export type JudgeSubject = {
  readonly id: string;
  readonly issueTitle: string;
  readonly issueBody: string;
  readonly plan: unknown;
  readonly implement: unknown;
  readonly test: unknown;
  readonly review: unknown;
  readonly changes: readonly string[];
  readonly files: number;
  readonly lines: number;
  readonly maxFiles: number;
  readonly maxLines: number;
};

export type Judge = (subject: JudgeSubject) => Promise<JudgeVerdict>;

const judgeReasonSchema = z
  .object({
    rule: z.enum(JUDGE_RULES),
    verdict: z.enum(["pass", "fail"]),
    reason: z.string().min(1),
  })
  .strict();

const judgeVerdictSchema = z
  .object({
    verdict: z.enum(["pass", "fail"]),
    reasons: z.array(judgeReasonSchema).length(JUDGE_RULES.length),
  })
  .strict();

export function judgeReplay(subject: JudgeSubject): JudgeVerdict {
  const reasons = [judgePlan(subject), judgeFiles(subject), judgeTests(subject), judgeReview(subject)];
  return { verdict: overall(reasons), reasons };
}

export function judgePrompt(subject: JudgeSubject): string {
  return [
    "Score this specialist run. Reply with one JSON object. No markdown fences.",
    'Shape: {"verdict":"pass"|"fail","reasons":[{"rule":"plan"|"files"|"tests"|"review","verdict":"pass"|"fail","reason":string}]}.',
    "Include one reason for each rule, in this order: plan, files, tests, review.",
    "verdict is pass only when every rule is pass.",
    "Rules:",
    "- plan: pass when the plan matches the planner contract, including at least one step. Fail when steps is empty.",
    "- files: pass when the implementer files list equals the recorded change paths.",
    "- tests: pass when passed is true and the plan has steps. Pass when passed is false and the review notes are non-empty. Fail when passed is true and the plan has no steps. Fail when passed is false and the review notes are empty.",
    "- review: pass when an empty plan, a failed test, or an over-budget diff has at least one review note. Pass when none of those problems are present. Fail when a problem is present and notes is empty.",
    "The budget is maxFiles and maxLines on the subject. files and lines are the measured diff.",
    "Subject:",
    JSON.stringify(subject),
  ].join("\n");
}

export function parseJudgeText(text: string): JudgeVerdict {
  const raw = unwrapJson(text);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("judge text is not JSON");
  }
  const parsed = judgeVerdictSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "(root)";
    throw new Error(`judge text invalid at ${path}: ${issue?.message ?? "invalid"}`);
  }
  const reasons = orderReasons(parsed.data.reasons);
  const verdict = overall(reasons);
  if (parsed.data.verdict !== verdict) {
    throw new Error("judge verdict does not match the rules");
  }
  return { verdict, reasons };
}

export function createJudge(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
): { readonly judge: Judge; spentUsd(): number | null } {
  const mode = env.THIN_PR_JUDGE ?? "replay";
  if (mode === "" || mode === "replay") {
    return {
      judge: async (subject) => judgeReplay(subject),
      spentUsd: () => null,
    };
  }
  if (mode !== "live") {
    throw new Error("THIN_PR_JUDGE must be live or replay");
  }
  if (env.THIN_PR_MODEL !== "live") {
    throw new Error("THIN_PR_JUDGE=live requires THIN_PR_MODEL=live");
  }
  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY is missing");
  }
  const client = new AnthropicModelClient(key, fetchImpl);
  return {
    judge: async (subject) => parseJudgeText(await client.completePrompt(judgePrompt(subject))),
    spentUsd: () => client.spentUsd(),
  };
}

function judgePlan(subject: JudgeSubject): JudgeReason {
  const parsed = plannerOutput.safeParse(subject.plan);
  if (!parsed.success) {
    const steps = readSteps(subject.plan);
    if (steps && steps.length === 0) {
      return { rule: "plan", verdict: "fail", reason: "Plan has no steps." };
    }
    return { rule: "plan", verdict: "fail", reason: "Plan does not match the planner contract." };
  }
  const count = parsed.data.steps.length;
  return { rule: "plan", verdict: "pass", reason: `Plan has ${count} ${count === 1 ? "step" : "steps"}.` };
}

function judgeFiles(subject: JudgeSubject): JudgeReason {
  const parsed = implementerOutput.safeParse(subject.implement);
  if (!parsed.success) {
    return { rule: "files", verdict: "fail", reason: "Implementer output does not match the contract." };
  }
  if (!samePaths(parsed.data.files, subject.changes)) {
    return { rule: "files", verdict: "fail", reason: "Implementer files do not match the recorded diff." };
  }
  const count = parsed.data.files.length;
  return {
    rule: "files",
    verdict: "pass",
    reason: `Implementer files match the recorded diff (${count} ${count === 1 ? "file" : "files"}).`,
  };
}

function judgeTests(subject: JudgeSubject): JudgeReason {
  const parsed = testerOutput.safeParse(subject.test);
  if (!parsed.success) {
    return { rule: "tests", verdict: "fail", reason: "Tester output does not match the contract." };
  }
  const plan = plannerOutput.safeParse(subject.plan);
  if (parsed.data.passed && !plan.success) {
    return { rule: "tests", verdict: "fail", reason: "Tester recorded passed true without a plan." };
  }
  if (!parsed.data.passed) {
    const notes = reviewNotes(subject);
    if (notes === 0) {
      return { rule: "tests", verdict: "fail", reason: "Tester recorded passed false and the review has no notes." };
    }
    return { rule: "tests", verdict: "pass", reason: "Tester recorded passed false and the review notes say so." };
  }
  return { rule: "tests", verdict: "pass", reason: "Tester recorded passed true." };
}

function judgeReview(subject: JudgeSubject): JudgeReason {
  const parsed = reviewerOutput.safeParse(subject.review);
  if (!parsed.success) {
    return { rule: "review", verdict: "fail", reason: "Reviewer output does not match the contract." };
  }
  const problem = reviewProblem(subject);
  if (problem && parsed.data.notes.length === 0) {
    return { rule: "review", verdict: "fail", reason: problem };
  }
  if (problem) {
    return { rule: "review", verdict: "pass", reason: "Review notes cover the failed check." };
  }
  return { rule: "review", verdict: "pass", reason: "Review notes are empty on a passing run." };
}

function reviewProblem(subject: JudgeSubject): string | null {
  if (subject.files > subject.maxFiles || subject.lines > subject.maxLines) {
    const files = subject.files === 1 ? "1 file" : `${subject.files} files`;
    const lines = subject.lines === 1 ? "1 line" : `${subject.lines} lines`;
    return `Review has no notes for a diff over the budget (${files}, ${lines}).`;
  }
  const tests = testerOutput.safeParse(subject.test);
  if (tests.success && !tests.data.passed) {
    return "Review has no notes for a failed test.";
  }
  if (!plannerOutput.safeParse(subject.plan).success) {
    return "Review has no notes for an empty plan.";
  }
  return null;
}

function reviewNotes(subject: JudgeSubject): number {
  const parsed = reviewerOutput.safeParse(subject.review);
  return parsed.success ? parsed.data.notes.length : 0;
}

function overall(reasons: readonly JudgeReason[]): "pass" | "fail" {
  return reasons.every((reason) => reason.verdict === "pass") ? "pass" : "fail";
}

function orderReasons(reasons: readonly JudgeReason[]): JudgeReason[] {
  const byRule = new Map(reasons.map((reason) => [reason.rule, reason]));
  if (byRule.size !== JUDGE_RULES.length) {
    throw new Error("judge reasons must include plan, files, tests, and review once each");
  }
  return JUDGE_RULES.map((rule) => {
    const reason = byRule.get(rule);
    if (!reason) {
      throw new Error(`judge response is missing ${rule}`);
    }
    return reason;
  });
}

function unwrapJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced?.[1] ?? trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("judge text has no JSON object");
  }
  return body.slice(start, end + 1);
}

function readSteps(value: unknown): unknown[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("steps" in value)) {
    return null;
  }
  return Array.isArray(value.steps) ? value.steps : null;
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((path, index) => path === b[index]);
}
