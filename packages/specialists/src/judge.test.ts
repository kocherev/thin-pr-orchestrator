import { describe, expect, it } from "vitest";
import {
  costOf,
  JUDGE_EFFORT,
  JUDGE_MODEL,
  judgeRequest,
  readJudgeResult,
  runJudgeBatch,
  scriptedBatchUpstream,
  SpendLimitError,
  type JudgeSubject,
  type JudgeVerdict,
} from "./index.js";

describe("batch judge", () => {
  it("sends every run in one batch, polls until it ends, and reads a verdict per case", async () => {
    const sent: { method: string; path: string; beta: string | null; body: string }[] = [];
    const upstream = scriptedBatchUpstream({ "01-clamp-decrement": passing(), "09-failing-hidden-test": failingReview() });
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      sent.push({ method: init?.method ?? "GET", path: new URL(String(url)).pathname, beta: headers.get("anthropic-beta"), body: String(init?.body ?? "") });
      return upstream(url, init);
    };
    const polls: string[] = [];

    const results = await runJudgeBatch([judgeRequest(subject("01-clamp-decrement")), judgeRequest(subject("09-failing-hidden-test"))], {
      apiKey: "test-key",
      spendLimitUsd: 25,
      pollMs: 0,
      fetch: fetchImpl,
      onPoll: (batch) => polls.push(batch.processing_status),
    });

    expect(sent.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v1/messages/batches",
      "GET /v1/messages/batches/msgbatch_scripted",
      "GET /v1/messages/batches/msgbatch_scripted",
      "GET /v1/messages/batches/msgbatch_scripted/results",
    ]);
    expect(polls).toEqual(["in_progress"]);
    expect(sent[0]?.beta).toContain("message-batches-2024-09-24");
    const body = JSON.parse(sent[0]?.body ?? "{}") as { requests: { custom_id: string; params: Record<string, unknown> }[] };
    expect(body.requests.map((request) => request.custom_id)).toEqual(["01-clamp-decrement", "09-failing-hidden-test"]);
    const params = body.requests[0]?.params ?? {};
    expect(params).toMatchObject({
      model: "claude-sonnet-5-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema" } },
    });
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
    expect(params).not.toHaveProperty("top_k");
    expect(JSON.stringify(params.messages)).toContain("<issue>\\nClamp decrement at zero");
    expect(JSON.stringify(params)).not.toContain("test-key");

    const read = results.map((result) => ({ id: result.custom_id, ...readJudgeResult(result.result) }));
    expect(read.map((result) => (result.outcome === "graded" ? result.verdict.review_quality.verdict : result.error))).toEqual(["pass", "fail"]);
    const usage = results[0]?.result.type === "succeeded" ? results[0].result.message.usage : null;
    if (!usage) throw new Error("no usage");
    // Batch requests cost half the standard rate.
    expect(read[0]?.costUsd).toBeCloseTo(costOf(JUDGE_MODEL, usage) / 2, 12);
    expect(JUDGE_EFFORT).toBe("medium");
  });

  it("reports a missing reply, a refusal, a cut-off reply and a reply off the schema as errors", async () => {
    const results = await runJudgeBatch([judgeRequest(subject("01-clamp-decrement")), judgeRequest(subject("02-thousands-separator"))], {
      apiKey: "test-key",
      spendLimitUsd: 25,
      pollMs: 0,
      fetch: scriptedBatchUpstream({ "01-clamp-decrement": { plan_relevance: { verdict: "pass", reason: "Only one." } } }),
    });
    expect(results.map((result) => readJudgeResult(result.result))).toEqual([
      expect.objectContaining({ outcome: "error", error: expect.stringContaining("judge output invalid at minimal_diff") }),
      { outcome: "error", error: "the request errored: invalid_request_error: no scripted reply for 02-thousands-separator", costUsd: 0 },
    ]);

    const message = (stop_reason: string, text: string, category: string | null = null) => ({
      type: "succeeded",
      message: {
        model: JUDGE_MODEL,
        stop_reason,
        stop_details: category ? { type: "refusal", category } : null,
        content: [{ type: "text", text }],
        usage: { input_tokens: 1000, output_tokens: 100 },
      },
    });
    expect(readJudgeResult(message("refusal", "", "cyber"))).toMatchObject({
      outcome: "error",
      error: "judge request was refused by claude-sonnet-5-5 (category: cyber)",
    });
    expect(readJudgeResult(message("max_tokens", "{"))).toMatchObject({ outcome: "error", error: "judge reply was cut off at max_tokens 16000" });
    expect(readJudgeResult(message("end_turn", "not json"))).toMatchObject({ outcome: "error", error: "judge output invalid at (root): reply is not JSON" });
    expect(readJudgeResult({ type: "expired" })).toEqual({ outcome: "error", error: "the request expired", costUsd: 0 });
    expect(readJudgeResult({ nope: true })).toEqual({ outcome: "error", error: "the result is not a message batch result", costUsd: 0 });
    expect(readJudgeResult(message("end_turn", JSON.stringify(passing())))).toMatchObject({ outcome: "graded", verdict: passing() });
  });

  it("refuses a batch whose largest output could pass the spend limit", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("fetch should not run");
    };
    const requests = Array.from({ length: 4 }, (_, index) => judgeRequest(subject(`case-${index}`)));
    // Four requests at 16,000 output tokens and half the Sonnet rate can cost 0.32 USD.
    await expect(runJudgeBatch(requests, { apiKey: "test-key", spendLimitUsd: 0.3, pollMs: 0, fetch: fetchImpl })).rejects.toThrow(SpendLimitError);
    await expect(runJudgeBatch(requests, { apiKey: undefined, spendLimitUsd: 25, pollMs: 0, fetch: fetchImpl })).rejects.toThrow(
      "ANTHROPIC_API_KEY is missing",
    );
  });
});

function passing(): JudgeVerdict {
  return {
    plan_relevance: { verdict: "pass", reason: "The plan changes decrement only." },
    minimal_diff: { verdict: "pass", reason: "One line changes." },
    test_adequacy: { verdict: "pass", reason: "No tests were added." },
    review_quality: { verdict: "pass", reason: "The approval matches a correct change." },
  };
}

function failingReview(): JudgeVerdict {
  return { ...passing(), review_quality: { verdict: "fail", reason: "The review approves a failing test." } };
}

function subject(caseId: string): JudgeSubject {
  return {
    caseId,
    issue: "Clamp decrement at zero\n\ndecrement in src/counter.ts should not return a negative count.",
    status: "opened",
    error: null,
    plan: { summary: "Stop decrement from going below zero.", steps: ["Change decrement in src/counter.ts"] },
    patch: "-  return value - 1;\n+  return Math.max(0, value - 1);",
    checks: [{ name: "test", command: "vitest run", exitCode: 0, durationMs: 0, logTail: "" }],
    review: { summary: "The clamp matches the issue.", verdict: "approve", notes: [] },
  };
}
