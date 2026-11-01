import type { ModelClient, SpecialistName } from "./contract.js";
import { ReplayModelClient } from "./specialists.js";

export const LIVE_MODEL_ID = "claude-haiku-5-5" as const;
export const LIVE_EFFORT = "low" as const;

// shortcut: published Haiku 5.5 rates as of the model page, update when those rates change.
const INPUT_USD_PER_TOKEN = 0.1 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 0.5 / 1_000_000;
const SPEND_LIMIT_USD = 3;

type MessageResponse = {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly stop_reason?: string;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
};

export class AnthropicModelClient implements ModelClient {
  private spent = 0;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  spentUsd(): number {
    return this.spent;
  }

  async complete(request: {
    readonly specialist: SpecialistName;
    readonly prompt: string;
  }): Promise<string> {
    return this.send(wrapPrompt(request), request.specialist);
  }

  async completePrompt(prompt: string): Promise<string> {
    return this.send(prompt, "judge");
  }

  private async send(prompt: string, label: string): Promise<string> {
    if (this.spent >= SPEND_LIMIT_USD) {
      throw new Error("live model spend reached 3 USD");
    }
    const payload = {
      model: LIVE_MODEL_ID,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: LIVE_EFFORT },
      messages: [{ role: "user", content: prompt }],
    };
    const response = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as MessageResponse & { readonly error?: { readonly message?: string } };
    if (!response.ok) {
      const message = body.error?.message ?? `live model request failed (${response.status})`;
      throw new Error(message);
    }
    this.spent += cost(body.usage);
    if (this.spent > SPEND_LIMIT_USD) {
      throw new Error("live model spend reached 3 USD");
    }
    if (body.stop_reason === "max_tokens") {
      throw new Error(`${label} model text was cut off`);
    }
    const text = (body.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    if (text.trim().length === 0) {
      throw new Error(`${label} model text is empty`);
    }
    return text;
  }
}

export function createModelClient(env: Record<string, string | undefined> = process.env): ModelClient {
  const mode = env.THIN_PR_MODEL ?? "replay";
  if (mode === "" || mode === "replay") {
    return new ReplayModelClient();
  }
  if (mode !== "live") {
    throw new Error("THIN_PR_MODEL must be live or replay");
  }
  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY is missing");
  }
  return new AnthropicModelClient(key);
}

const SHAPES: Record<SpecialistName, string> = {
  planner: '{"summary": string, "steps": [string, ...]} with at least one step.',
  implementer:
    '{"summary": string, "files": [string, ...], "edits": [{"path": string, "content": string}, ...]}. content is the full new file. Change only the files the issue names. Keep the diff inside 2 files and 16 lines.',
  tester: '{"summary": string, "passed": true} when the change matches the issue. Use false only when the change does not.',
  reviewer: '{"summary": string, "notes": string[]}. notes may be empty.',
  "pr-writer": '{"summary": string, "title": string, "body": string}.',
};

function wrapPrompt(request: { readonly specialist: SpecialistName; readonly prompt: string }): string {
  return [
    "Reply with one JSON object. No markdown fences.",
    `Shape: ${SHAPES[request.specialist]}`,
    request.prompt,
  ].join("\n");
}

function cost(usage: MessageResponse["usage"]): number {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  return input * INPUT_USD_PER_TOKEN + output * OUTPUT_USD_PER_TOKEN;
}
