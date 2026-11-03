import type { Json } from "@thin-pr/core";
import { z } from "zod";
import type { SpecialistName } from "./contract.js";

/** One assistant turn of tool calls. */
export type ScriptedTurn = readonly { readonly name: string; readonly input: Json }[];

/**
 * What each specialist answers. A structured specialist takes its replies in call order and repeats the last one.
 * The planner may first play `plannerReads`, tool turns of `read_file` and `search`, before each reply.
 * The implementer plays its turns on the first pass, then ends each pass with the summary.
 */
export type Script = {
  readonly planner: readonly [Json, ...Json[]];
  readonly plannerReads?: readonly ScriptedTurn[];
  readonly implementer: { readonly turns: readonly ScriptedTurn[]; readonly summary: string };
  readonly reviewer: readonly [Json, ...Json[]];
  readonly "pr-writer": readonly [Json, ...Json[]];
};

const request = z.looseObject({
  model: z.string(),
  messages: z.array(z.looseObject({ role: z.string() })),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.looseObject({ type: z.string() }).optional(),
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
    const turn = body.messages.filter((message) => message.role === "assistant").length;
    const toolUse = (prefix: string, scripted: ScriptedTurn) =>
      reply(
        body.model,
        text,
        "tool_use",
        scripted.map((tool, index) => ({ type: "tool_use", id: `toolu_${prefix}_${turn}_${index}`, name: tool.name, input: tool.input })),
      );

    if (specialist !== "implementer") {
      // With tool_choice none the API returns no tool call, so the planner replies.
      const reads = specialist === "planner" && body.tool_choice?.type !== "none" ? script.plannerReads?.[turn] : undefined;
      if (reads) {
        return toolUse("plan", reads);
      }
      const call = calls[specialist] ?? 0;
      calls[specialist] = call + 1;
      const replies = script[specialist];
      return reply(body.model, text, "end_turn", [{ type: "text", text: JSON.stringify(replies[Math.min(call, replies.length - 1)]) }]);
    }
    if (turn === 0) {
      implementerPasses += 1;
    }
    const scripted = implementerPasses === 1 ? script.implementer.turns[turn] : undefined;
    if (!scripted) {
      return reply(body.model, text, "end_turn", [{ type: "text", text: script.implementer.summary }]);
    }
    return toolUse(String(implementerPasses), scripted);
  };
}

// The planner sends read tools and an output schema, so the schema decides first.
function specialistOf(body: z.infer<typeof request>): SpecialistName {
  const properties = body.output_config?.format?.schema.properties ?? {};
  if ("verdict" in properties) return "reviewer";
  if ("title" in properties) return "pr-writer";
  if ("steps" in properties) return "planner";
  if (body.tools) return "implementer";
  throw new Error("scripted upstream cannot tell which specialist sent this request");
}

/**
 * A stand-in for the Message Batches API. Each request gets `replies[custom_id]` as its JSON text, and a request with
 * no reply errors. The batch is in progress when it is created and has ended by the first poll.
 */
export function scriptedBatchUpstream(replies: Readonly<Record<string, Json>>): typeof fetch {
  const batches = z.object({ requests: z.array(z.object({ custom_id: z.string(), params: z.looseObject({ model: z.string() }) })) });
  let lines: string[] = [];
  const batch = (ended: boolean) => {
    const base = "https://api.anthropic.com/v1/messages/batches/msgbatch_scripted";
    return Response.json({
      id: "msgbatch_scripted",
      type: "message_batch",
      processing_status: ended ? "ended" : "in_progress",
      request_counts: { processing: ended ? 0 : lines.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      results_url: ended ? `${base}/results` : null,
      created_at: "2026-11-02T00:00:00Z",
      ended_at: ended ? "2026-11-02T00:01:00Z" : null,
      expires_at: "2026-11-03T00:00:00Z",
      archived_at: null,
      cancel_initiated_at: null,
    });
  };

  return async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/messages/batches" && init?.method === "POST") {
      const sent = batches.parse(JSON.parse(String(init.body)));
      lines = sent.requests.map(({ custom_id, params }) => {
        const answer = replies[custom_id];
        const result =
          answer === undefined
            ? { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: `no scripted reply for ${custom_id}` } } }
            : { type: "succeeded", message: message(params.model, JSON.stringify(params), "end_turn", [{ type: "text", text: JSON.stringify(answer) }]) };
        return JSON.stringify({ custom_id, result });
      });
      return batch(false);
    }
    if (path === "/v1/messages/batches/msgbatch_scripted") {
      return batch(true);
    }
    if (path === "/v1/messages/batches/msgbatch_scripted/results") {
      return new Response(`${lines.join("\n")}\n`, { headers: { "content-type": "application/binary" } });
    }
    return Response.json({ type: "error", error: { type: "not_found_error", message: path } }, { status: 404 });
  };
}

function reply(model: string, sent: string, stopReason: string, content: readonly Json[]): Response {
  return Response.json(message(model, sent, stopReason, content));
}

// Token counts are estimates at four characters a token, plus a little thinking.
function message(model: string, sent: string, stopReason: string, content: readonly Json[]) {
  return {
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
  };
}
