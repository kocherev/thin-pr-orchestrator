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

`ModelClient.complete` takes the specialist name and a prompt, and returns a string. The specialist parses that string as JSON. This tree's client is `ReplayModelClient`. It returns the override you passed, or the built-in fixture for that specialist. A live model client would implement the same method. It would live in `packages/specialists`, not in `packages/core`.

The step context carries `workdir`, the model client, a log function, and a budget of 2000 tokens and 30 seconds. An empty workdir or a non-positive budget throws before the model is called. The prompt sent to the client is JSON with those fields and the step input. The control plane never sees the prompt.

The adapter in `packages/specialists/src/adapter.ts` maps template steps onto those five specialists and stores each parsed output on a capture object. The gate and the draft body read that object. They do not read the model text a second time.

## Gate rules

`evaluate()` always returns three results, in this order.

| Rule | Pass | Fail |
| --- | --- | --- |
| `plan` | The planner output parses, and `steps` has at least one entry. | The plan is missing, or it does not match the planner schema. |
| `tests` | The tester output parses and `passed` is true. | The test result is missing, it does not match the tester schema, or `passed` is false. |
| `contracts` | Plan, implement, test, review, and pr-writer outputs each match their schema. | The first missing or invalid output fails the rule. |

`decide(subject)` returns `pass` only when all three verdicts are `PASS`. `decide()` with no argument returns `pass`. `packages/github` calls `decide(capture)` with the five outputs, and that call is the one that can block the draft.

On the draft path the hook runs after pr-writer and before the gate step is recorded as finished. Each rule posts a check named `thin-pr / gate / <rule>`. The title is the verdict. The summary is the verdict, a colon, and the reason. If any rule fails, the machine throws `gate decide returned fail`. The orchestrator marks the open check as failure, comments `## Run report` on the issue, and does not call the pull-request API.

If every rule passes, the orchestrator opens a draft. The title is the pr-writer `title`, or `thin-pr #<issue number>` when that field is absent. The body is assembled in `formatDraftBody`: `## Plan`, `## Test results`, then `## Run report`. The pr-writer `body` field is not that text.

## Replay evals

`pnpm eval` does not call a live model and does not call GitHub. For each file in `evals/issues` it loads the matching response, runs the labeled-issue path with `ReplayModelClient`, and scores the recorded diff against `evals/sample-repo`.

A case passes the gate when that run returns `completed`. `09-failing-tests` and `10-empty-plan` return `failed`. The other ten return `completed`. The floor in `evals/baseline.json` is that 10/12 rate. The process exits 1 when the rate is lower. It does not exit 1 for a diff that misses `evals/budget.json`.

The budget is 2 files and 16 lines. Line counts are insertions plus deletions, from a longest common subsequence of the source lines. `11-wide-touch` changes 4 files. `12-long-readme` changes 31 lines. Both pass the gate. The report's file stats on this set are min 1, median 1, max 4. The line stats are min 1, median 2.5, max 31. Ten cases are inside the budget. The two gate failures are also inside the budget, so that 10 is a different pair from the 10 gate passes.

CI runs `pnpm eval` after the tests. Lowering `evals/baseline.json` to make a red run green hides the regression the file is there to catch.

## Non-goals

- This tree does not call a live model. A new client implements `ModelClient` and stays behind the specialist boundary.
- The Action does not write `evals/diffs` into the branch. The head commit keeps the default branch tree so the checks have a SHA.
- The Action does not merge the pull request, request reviewers, or close the issue.
- The label path does not choose a template. It loads `small-feature`.
- There is no chat UI, no second orchestrator, and no general agent loop.
- `packages/core` does not grow a model SDK import or a GitHub client import. `skills/core-boundary` is the list.
