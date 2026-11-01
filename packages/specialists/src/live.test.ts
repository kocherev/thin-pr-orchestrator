import { describe, expect, it } from "vitest";
import { AnthropicModelClient, createModelClient, LIVE_EFFORT, LIVE_MODEL_ID } from "./live.js";
import { ReplayModelClient } from "./specialists.js";

describe("live model client", () => {
  it("stays on replay unless the live path is requested", () => {
    expect(createModelClient({})).toBeInstanceOf(ReplayModelClient);
    expect(createModelClient({ THIN_PR_MODEL: "replay", ANTHROPIC_API_KEY: "test-key" })).toBeInstanceOf(
      ReplayModelClient,
    );
    expect(() => createModelClient({ THIN_PR_MODEL: "live" })).toThrow("ANTHROPIC_API_KEY is missing");
    expect(createModelClient({ THIN_PR_MODEL: "live", ANTHROPIC_API_KEY: "test-key" })).toBeInstanceOf(
      AnthropicModelClient,
    );
  });

  it("pins adaptive thinking and omits sampling parameters", async () => {
    let body = "";
    const client = new AnthropicModelClient("test-key", async (_url, init) => {
      body = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "thinking", thinking: "skip" }, { type: "text", text: "{\"ok\":true}" }],
          usage: { input_tokens: 1000, output_tokens: 500 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await expect(client.complete({ specialist: "implementer", prompt: "{\"input\":1}" })).resolves.toContain("ok");
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload.model).toBe(LIVE_MODEL_ID);
    expect(payload.thinking).toEqual({ type: "adaptive" });
    expect(payload.output_config).toEqual({ effort: LIVE_EFFORT });
    expect(JSON.stringify(payload.messages)).toContain("edits");
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("top_p");
    expect(payload).not.toHaveProperty("top_k");
    expect(JSON.stringify(payload)).not.toContain("test-key");
    expect(client.spentUsd()).toBeCloseTo((1000 * 0.1 + 500 * 0.5) / 1_000_000);
  });
});
