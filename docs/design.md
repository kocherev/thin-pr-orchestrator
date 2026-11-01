# Design

Why the control plane is a short TypeScript program, and what it refuses to do.

## Fixed step order

`packages/core` walks a template and appends each transition to SQLite. The next step is the next entry in the file. The package does not call a model, and it does not import a GitHub client.

A framework that keeps looping on a model would hide three decisions inside that loop: which step runs, how many times it may be retried, and whether a pull request opens. Here those decisions are data.

- The template names the specialist, the fields, the retry count, and an optional gate hook. `templates/README.md` describes the three YAML files and `templates/stub-run.json`.
- `retries` is the number of extra attempts after the first failure. `templates/small-feature.yaml` allows one extra attempt for each worker and no extra attempt for the gate.
- The labeled-issue path always loads `templates/small-feature.yaml`. The other templates are for the loader and the tests.
- `decide()` returns `pass` or `fail`. The machine throws if the hook is missing or returns anything else. The same issue text, template, and model replies produce the same log, so `replay` can fold that log back into the final state.

The orchestrator in `packages/github` is the caller. It creates the branch, posts the checks, and either opens the draft or comments the run report. Moving that code into the control plane would put the GitHub client on the wrong side of the boundary.

## Specialist contract

Five names are fixed: `planner`, `implementer`, `tester`, `reviewer`, and `pr-writer`. Each specialist has a Zod input schema and a Zod output schema, both `.strict()`. `executeSpecialist` parses the input, calls `run`, then parses the output. A bad value throws `SpecialistSchemaError` with the specialist name, the phase, and the path of the first issue. The step then uses its remaining retries or fails.

`ModelClient.complete` takes the specialist name and a prompt, and returns a string. The specialist parses that string as JSON. The default client is `ReplayModelClient`. It returns the override you passed, or the built-in fixture for that specialist. `createModelClient` returns that client unless `THIN_PR_MODEL` is `live`. The live client is `AnthropicModelClient` in `packages/specialists/src/live.ts`. It stays out of `packages/core`.

The step context carries `workdir`, the model client, a log function, and a budget of 2000 tokens and 30 seconds. An empty workdir or a non-positive budget throws before the model is called. The prompt sent to the client is JSON with those fields and the step input. The control plane never sees the prompt.

The adapter in `packages/specialists/src/adapter.ts` maps template steps onto those five specialists and stores each parsed output on a capture object. The gate and the draft body read that object. They do not read the model text a second time.

## Gate rules

`evaluate()` always returns five results, in this order.

| Rule | Pass | Fail |
| --- | --- | --- |
| `plan` | The planner output parses, and `steps` has at least one entry. | The plan is missing, or it does not match the planner schema. |
| `tests` | The tester output parses, `passed` is true, and the runner's file check passed. | The test result is missing, it does not match the tester schema, `passed` is false, or the runner did not confirm the files. |
| `contracts` | Plan, implement, test, review, and pr-writer outputs each match their schema. | The first missing or invalid output fails the rule. |
| `diff` | The runner measured at least one changed line of non-whitespace text. | The diff was not measured, it is empty, or only whitespace changed. |
| `budget` | The measured file count and line count are within the limits passed by the runner. | The measurement is missing, or it exceeds the file or line limit. |

`decide(subject, runner)` returns `pass` only when all five verdicts are `PASS`. `decide()` with no argument returns `pass`. `packages/github` calls `decide(capture, evidence)` with the five outputs and the runner measurement. That call can block the draft. The measurement comes from `measureDiff` on the file bytes. The model's `files` array is not that measurement.

On the draft path the hook runs after pr-writer and before the gate step is recorded as finished. Each rule posts a check named `thin-pr / gate / <rule>`. The title is the verdict. The summary is the verdict, a colon, and the reason. If any rule fails, the machine throws `gate decide returned fail`. The orchestrator marks the open check as failure, comments `## Run report` on the issue, and does not call the pull-request API.

If every rule passes, the orchestrator opens a draft. The title is the pr-writer `title`, or `thin-pr #<issue number>` when that field is absent. The body is assembled in `formatDraftBody`: `## Plan`, `## Test results`, then `## Run report`. The pr-writer `body` field is not that text.

## Replay evals

`pnpm eval` does not call a live model and does not call GitHub. For each file in `evals/issues` it loads the matching response, runs the labeled-issue path with `ReplayModelClient`, and scores the recorded diff against `evals/sample-repo`.

A case passes the gate when that run returns `completed`. `09-failing-tests`, `10-empty-plan`, `11-wide-touch`, and `12-long-readme` return `failed`. The other eight return `completed`. The floor in `evals/baseline.json` is that 8/12 rate. The process exits 1 when the rate is lower.

The budget is 2 files and 16 lines. Line counts are insertions plus deletions, from a longest common subsequence of the source lines. `11-wide-touch` changes 4 files. `12-long-readme` changes 31 lines. Both fail the budget rule. The report's file stats on this set are min 1, median 1, max 4. The line stats are min 1, median 2.5, max 31. Ten cases are inside the budget. `09` and `10` are inside the budget and still fail the gate, so the within-budget count is not the pass count.

CI runs `pnpm eval` after the tests. Lowering `evals/baseline.json` to make a red run green hides the regression the file is there to catch.

## Traces and the judge

`runWorkflow` opens spans with `@opentelemetry/api`. A process that never starts the SDK records nothing. `packages/github` starts the SDK for `pnpm trace` and for the labeled-issue Action. The exported document is OTLP JSON. The sample is `docs/demo/trace.json`.

The judge scores a finished replay. `decide()` still reads plan, tests, contracts, diff, and budget, and that result still chooses the draft. `pnpm eval:judge` applies the rubric in `packages/specialists/src/judge.ts` to the 12 recorded cases. The live client in that package runs when `THIN_PR_JUDGE` and `THIN_PR_MODEL` are both `live` and `ANTHROPIC_API_KEY` is set.

## Non-goals

- CI and `pnpm eval` do not call a live model. The live client runs only when `THIN_PR_MODEL=live` and `ANTHROPIC_API_KEY` is set, and it stays in `packages/specialists`.
- The Action commits the measured file bytes on `thin-pr/<issue>`. It does not commit an empty copy of the default branch tree. `pnpm eval` does not push `evals/diffs`.
- The Action does not merge the pull request, request reviewers, or close the issue.
- The label path does not choose a template. It loads `small-feature`.
- There is no chat UI, no second orchestrator, and no general agent loop.
- `packages/core` does not grow a model SDK import or a GitHub client import. `skills/core-boundary` is the list.
