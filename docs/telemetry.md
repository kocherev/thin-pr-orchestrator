# Telemetry

Each run is one OpenTelemetry trace. `packages/core` opens a span for the run and one for each pass over a template step. The Anthropic SDK (`@anthropic-ai/sdk` 0.135.0) opens a span for each model request and each tool run inside those steps. `packages/specialists` adds the specialist name and the cost to each request span. Step and run spans carry the totals.

## Span tree

This is `docs/demo/trace.json`, the gate-pass replay that `pnpm trace` writes. It has 15 spans in one trace.

```text
thin-pr.run                                 packages/core
  thin-pr.plan                              packages/core
    anthropic.messages.create               SDK, CLIENT
  thin-pr.implement                         packages/core
    anthropic.messages.tool_runner          SDK
      anthropic.messages.create             SDK, CLIENT
      anthropic.custom_tool_use read_file   SDK
      anthropic.messages.create             SDK, CLIENT
      anthropic.custom_tool_use replace     SDK
      anthropic.messages.create             SDK, CLIENT
  thin-pr.verify                            packages/core
  thin-pr.review                            packages/core
    anthropic.messages.create               SDK, CLIENT
  thin-pr.write                             packages/core
    anthropic.messages.create               SDK, CLIENT
```

A loop back to a step opens a second span with the same name and a higher `thin_pr.loop`. Retries stay in one step span, and `thin_pr.attempts` counts them.

## Where the spans go

`startTrace` in `packages/github/src/trace.ts` picks the exporter once per process. `pnpm trace` and the labeled-issue Action both call it.

- When `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set, `@opentelemetry/sdk-node` builds the OTLP exporter from the standard variables. It reads `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL`. The protocol defaults to `http/protobuf`. Nothing is written to `THIN_PR_TRACE_PATH`, and `pnpm trace` prints `sent to the OTLP endpoint`.
- Otherwise the spans stay in memory, and the process writes one OTLP JSON document to `THIN_PR_TRACE_PATH`. With that variable empty, `pnpm trace` prints the document to stdout.

The resource has one attribute, `service.name` set to `thin-pr-orchestrator`. Host and process detectors are off. To see export errors, set `OTEL_LOG_LEVEL=debug`.

## Send a run to a backend

### Local Jaeger

```bash
docker run --rm -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:2.22.0
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm trace
```

Open `http://localhost:16686` and pick the service `thin-pr-orchestrator`. Jaeger 2.22.0 shows the 15 spans above in one trace. `docker stop jaeger` stops and removes the container.

### Honeycomb

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io \
OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=$HONEYCOMB_API_KEY" \
pnpm trace
```

Use `https://api.eu1.honeycomb.io` for an EU team. Honeycomb names the dataset after `service.name`.

### Grafana Cloud

Take the endpoint, the instance ID, and a token with the `traces:write` scope from the stack's OpenTelemetry connection page.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-us-east-0.grafana.net/otlp \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic%20$(printf '%s:%s' "$GRAFANA_INSTANCE_ID" "$GRAFANA_TOKEN" | base64)" \
pnpm trace
```

The header value is percent-encoded, so the space after `Basic` is `%20`. The traces appear in the stack's Tempo data source.

This repo was checked against Jaeger. The Honeycomb and Grafana Cloud values follow each vendor's OTLP setup page.

### The labeled-issue Action

Set the repository variable `OTEL_EXPORTER_OTLP_ENDPOINT` and the repository secret `OTEL_EXPORTER_OTLP_HEADERS`. `.github/workflows/thin-pr.yml` passes both to the run. With the variable set, the workflow sends the trace to that backend and skips the `thin-pr-trace` artifact.

## Attributes

### `thin-pr.run`

| Attribute | Value |
|---|---|
| `thin_pr.run_id` | The run id, such as `run-7` or `gha-<GITHUB_RUN_ID>` |
| `thin_pr.template_id` | The template, such as `small-feature` |
| `thin_pr.usage.*` | The run totals. The five names are listed under the step spans |

### `thin-pr.<step>`

| Attribute | Value |
|---|---|
| `thin_pr.step` | `plan`, `implement`, `verify`, `review`, or `write` |
| `thin_pr.loop` | 0 on the first pass over the step, 1 after one loop back |
| `thin_pr.attempts` | Attempts in this pass, retries included |
| `thin_pr.usage.requests` | Model requests in this pass |
| `thin_pr.usage.input_tokens` | Input tokens, cache reads and cache writes included |
| `thin_pr.usage.output_tokens` | Output tokens |
| `thin_pr.usage.cache_read_tokens` | Tokens read from the prompt cache |
| `thin_pr.usage.cost_usd` | Cost of those requests in USD |

The usage counts every attempt in the pass, failed attempts included. `verify` calls no model, so its totals are 0.

### `anthropic.messages.create`

The SDK sets these. They follow the OpenTelemetry GenAI semantic conventions.

| Attribute | Value |
|---|---|
| `gen_ai.provider.name` | `anthropic`. This name replaced `gen_ai.system` in the conventions |
| `gen_ai.operation.name` | `chat` |
| `gen_ai.request.model` | The model the step asked for, such as `claude-opus-5-5` |
| `gen_ai.response.model` | The model that answered |
| `gen_ai.response.id` | The message id |
| `gen_ai.request.max_tokens` | `max_tokens` of the request |
| `gen_ai.request.reasoning.level` | The effort: `low`, `medium`, `high`, `xhigh`, or `max` |
| `gen_ai.output.type` | `json` on the structured-output requests of the planner, reviewer, and pr-writer |
| `gen_ai.usage.input_tokens` | Input tokens, cache reads and cache writes included |
| `gen_ai.usage.output_tokens` | Output tokens |
| `gen_ai.usage.cache_read.input_tokens` | Tokens read from the prompt cache |
| `gen_ai.usage.cache_write.input_tokens` | Tokens written to the prompt cache |
| `anthropic.message.stop_reason` | The stop reason, such as `end_turn` or `tool_use` |
| `anthropic.thinking.type` | `adaptive` |
| `anthropic.beta` | The beta headers, such as the server-side fallback |
| `anthropic.request.id` | The API request id. Live calls only |

`packages/specialists/src/transport.ts` adds two more.

| Attribute | Value |
|---|---|
| `thin_pr.specialist` | `planner`, `implementer`, `reviewer`, or `pr-writer` |
| `thin_pr.cost_usd` | The price of this response from `packages/specialists/src/pricing.ts`. The spend meter adds the same number toward `THIN_PR_SPEND_LIMIT_USD` |

### Tool spans

`anthropic.messages.tool_runner` wraps the implementer's tool loop. Each `anthropic.custom_tool_use <tool>` span has `gen_ai.tool.name`, `gen_ai.tool.call.id`, and `gen_ai.tool.description`. The description is the fixed text in `packages/specialists/src/implementer.ts`.

### Totals

To total a run, read `thin_pr.usage.cost_usd` on `thin-pr.run`, or sum `thin_pr.cost_usd` over the `anthropic.messages.create` spans. Do not add the two. The step and run totals use `thin_pr.usage.*` names, so a backend that sums `gen_ai.usage.*` counts each request once.

## What the spans leave out

No span carries a prompt, the issue text, a model reply, a tool argument, a tool result, a diff, a check log, or file contents.

- `createAnthropicClient` sets the SDK option `openTelemetry` to `{ traces: { contentMode: "metadata_only" } }`. The SDK then records ids, models, token counts, and timings, and no message content. The option is set in code, so `ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE=content` in the environment has no effect.
- The `thin_pr.*` attributes are ids, step names, counts, and cost.
- A failed step records its error message as the span status and an exception event. The messages name the step, the specialist, the model, a limit, or a repository path, such as `implementer still wanted tools after 25 turns`. A failed git command adds git's stderr.

`scripts/trace.test.ts` checks the first rule on every run. The issue title and body, the planner input and reply, the file contents, the edit, and the edited path must not appear anywhere in the trace file.

In live mode the SDK also sends a `traceparent` header with each request. When the API organization exports its own server-side spans, those spans join the same trace as children of the request spans.
