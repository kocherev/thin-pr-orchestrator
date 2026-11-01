import { describe, expect, it } from "vitest";
import { createJudge, judgePrompt, judgeReplay, LIVE_EFFORT, LIVE_MODEL_ID, parseJudgeText, type JudgeSubject } from "./index.js";

describe("judge rubric", () => {
  it("fails an empty plan", () => {
    const verdict = judgeReplay(
      subject({
        plan: { summary: "Rename the helpers.", steps: [] },
        test: { summary: "The comment is present.", passed: true },
        review: { summary: "No behavior changed.", notes: [] },
      }),
    );
    expect(verdict.verdict).toBe("fail");
    expect(verdict.reasons.map((reason) => reason.rule)).toEqual(["plan", "files", "tests", "review"]);
    expect(verdict.reasons[0]).toMatchObject({ verdict: "fail", reason: "Plan has no steps." });
    expect(verdict.reasons[2]).toMatchObject({ verdict: "fail", reason: "Tester recorded passed true without a plan." });
    expect(verdict.reasons[3]).toMatchObject({ verdict: "fail", reason: "Review has no notes for an empty plan." });
  });

  it("fails a review that ignores an over-budget diff", () => {
    const verdict = judgeReplay(
      subject({
        files: 4,
        lines: 4,
        changes: ["src/counter.ts", "src/format.ts", "src/notes.ts", "src/parse.ts"],
        implement: {
          summary: "Mark the helper files.",
          files: ["src/counter.ts", "src/format.ts", "src/notes.ts", "src/parse.ts"],
        },
      }),
    );
    expect(verdict.verdict).toBe("fail");
    expect(verdict.reasons[3]).toMatchObject({
      verdict: "fail",
      reason: "Review has no notes for a diff over the budget (4 files, 4 lines).",
    });
  });

  it("passes when the tester records a failure and the review notes it", () => {
    const verdict = judgeReplay(
      subject({
        test: { summary: "TRUE still fails the recorded check.", passed: false },
        review: { summary: "The check is case-sensitive.", notes: ["The recorded tests did not pass."] },
      }),
    );
    expect(verdict.verdict).toBe("pass");
    expect(verdict.reasons.map((reason) => reason.verdict)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(verdict.reasons[2]?.reason).toBe("Tester recorded passed false and the review notes say so.");
  });

  it("stays on the rubric unless the live flags and a key are set", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("fetch should not run");
    };
    await expect(createJudge({}, fetchImpl).judge(subject({}))).resolves.toMatchObject({ verdict: "pass" });
    expect(createJudge({ THIN_PR_JUDGE: "replay", ANTHROPIC_API_KEY: "test-key" }, fetchImpl).spentUsd()).toBeNull();
    expect(() => createJudge({ THIN_PR_JUDGE: "live", ANTHROPIC_API_KEY: "test-key" }, fetchImpl)).toThrow(
      "THIN_PR_JUDGE=live requires THIN_PR_MODEL=live",
    );
    expect(() => createJudge({ THIN_PR_JUDGE: "live", THIN_PR_MODEL: "live" }, fetchImpl)).toThrow(
      "ANTHROPIC_API_KEY is missing",
    );
  });

  it("sends the rubric to claude-haiku-5-5 without sampling parameters", async () => {
    let body = "";
    const session = createJudge(
      { THIN_PR_JUDGE: "live", THIN_PR_MODEL: "live", ANTHROPIC_API_KEY: "test-key" },
      async (_url, init) => {
        body = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            stop_reason: "end_turn",
            content: [
              { type: "thinking", thinking: "skip" },
              { type: "text", text: JSON.stringify(passingText()) },
            ],
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    await expect(session.judge(subject({}))).resolves.toMatchObject({ verdict: "pass" });
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload.model).toBe(LIVE_MODEL_ID);
    expect(payload.thinking).toEqual({ type: "adaptive" });
    expect(payload.output_config).toEqual({ effort: LIVE_EFFORT });
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("top_p");
    expect(payload).not.toHaveProperty("top_k");
    expect(JSON.stringify(payload.messages)).toContain("plan:");
    expect(JSON.stringify(payload.messages)).not.toContain("test-key");
    expect(judgePrompt(subject({}))).toContain("verdict is pass only when every rule is pass.");
    expect(session.spentUsd()).toBeCloseTo((100 * 0.1 + 50 * 0.5) / 1_000_000);
  });

  it("rejects a verdict that disagrees with the rules", () => {
    const text = JSON.stringify({
      verdict: "pass",
      reasons: [
        { rule: "plan", verdict: "fail", reason: "Plan has no steps." },
        { rule: "files", verdict: "pass", reason: "Files match." },
        { rule: "tests", verdict: "pass", reason: "Tests passed." },
        { rule: "review", verdict: "pass", reason: "Review is empty." },
      ],
    });
    expect(() => parseJudgeText(text)).toThrow("judge verdict does not match the rules");
  });
});

function passingText(): unknown {
  return {
    verdict: "pass",
    reasons: [
      { rule: "plan", verdict: "pass", reason: "Plan has 1 step." },
      { rule: "files", verdict: "pass", reason: "Files match." },
      { rule: "tests", verdict: "pass", reason: "Tester recorded passed true." },
      { rule: "review", verdict: "pass", reason: "Review notes are empty on a passing run." },
    ],
  };
}

function subject(overrides: Partial<JudgeSubject>): JudgeSubject {
  return {
    id: "01-clamp-decrement",
    issueTitle: "Clamp decrement at zero",
    issueBody: "decrement in src/counter.ts should not return a negative count.",
    plan: { summary: "Stop decrement from going below zero.", steps: ["Change decrement in src/counter.ts"] },
    implement: { summary: "Clamp decrement at zero.", files: ["src/counter.ts"] },
    test: { summary: "Decrement stays at zero.", passed: true },
    review: { summary: "The clamp matches the issue.", notes: [] },
    changes: ["src/counter.ts"],
    files: 1,
    lines: 2,
    maxFiles: 2,
    maxLines: 16,
    ...overrides,
  };
}
