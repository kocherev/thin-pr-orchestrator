import type { Json } from "@thin-pr/core";
import { z } from "zod";
import type { SpecialistName } from "./contract.js";

/** One assistant turn of tool calls. */
export type ScriptedTurn = readonly { readonly name: string; readonly input: Json }[];

/**
 * What each specialist answers. A structured specialist takes its replies in call order and repeats the last one.
 * The implementer plays its turns on the first pass, then ends each pass with the summary.
 */
export type Script = {
  readonly planner: readonly [Json, ...Json[]];
  readonly implementer: { readonly turns: readonly ScriptedTurn[]; readonly summary: string };
  readonly reviewer: readonly [Json, ...Json[]];
  readonly "pr-writer": readonly [Json, ...Json[]];
};

const request = z.looseObject({
  model: z.string(),
  messages: z.array(z.looseObject({ role: z.string() })),
  tools: z.array(z.unknown()).optional(),
  output_config: z.looseObject({ format: z.looseObject({ schema: z.looseObject({ properties: z.record(z.string(), z.unknown()) }) }).optional() }).optional(),
});

/**
 * A stand-in for the Messages API, for tests and for rebuilding cassettes from older recordings. The specialist
 * header never reaches it, so it tells the specialists apart by their request: tools, or the output schema.
 */
export function scriptedUpstream(script: Script): typeof fetch {
  const calls: Partial<Record<SpecialistName, number>> = {};
  let implementerPasses = 0;

  return async (_url, init) => {
    const text = String(init?.body);
    const body = request.parse(JSON.parse(text));
    const specialist = specialistOf(body);
    const call = calls[specialist] ?? 0;
    calls[specialist] = call + 1;

    if (specialist !== "implementer") {
      const replies = script[specialist];
      return reply(body.model, text, "end_turn", [{ type: "text", text: JSON.stringify(replies[Math.min(call, replies.length - 1)]) }]);
    }
    const turn = body.messages.filter((message) => message.role === "assistant").length;
    if (turn === 0) {
      implementerPasses += 1;
    }
    const scripted = implementerPasses === 1 ? script.implementer.turns[turn] : undefined;
    if (!scripted) {
      return reply(body.model, text, "end_turn", [{ type: "text", text: script.implementer.summary }]);
    }
    const blocks = scripted.map((tool, index) => ({
      type: "tool_use",
      id: `toolu_${implementerPasses}_${turn}_${index}`,
      name: tool.name,
      input: tool.input,
    }));
    return reply(body.model, text, "tool_use", blocks);
  };
}

function specialistOf(body: z.infer<typeof request>): SpecialistName {
  if (body.tools) {
    return "implementer";
  }
  const properties = body.output_config?.format?.schema.properties ?? {};
  if ("verdict" in properties) return "reviewer";
  if ("title" in properties) return "pr-writer";
  if ("steps" in properties) return "planner";
  throw new Error("scripted upstream cannot tell which specialist sent this request");
}

// Token counts are estimates at four characters a token, plus a little thinking.
function reply(model: string, sent: string, stopReason: string, content: readonly Json[]): Response {
  return Response.json({
    id: `msg_${Math.ceil(sent.length / 7)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: Math.ceil(sent.length / 4),
      output_tokens: Math.ceil(JSON.stringify(content).length / 4) + 120,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
}
