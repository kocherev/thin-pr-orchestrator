# Design

Why the control plane is a short TypeScript program, and what it refuses to do.

## Fixed step order

`packages/core` walks a template and appends each step event to SQLite with its full JSON output and usage. The next step is the next entry in the file, unless a step loops back. The package does not call a model, and it does not import a GitHub client.

A framework that keeps looping on a model would hide three decisions inside that loop: which step runs, how many times it may be retried, and whether a pull request opens. Here those decisions are data.

- The template names the label that selects it and, for each step, the retry count, an optional model and effort, and an optional loop. `templates/README.md` describes the three YAML files.
- `retries` is the number of extra attempts after the first failure. Each retry gets the previous error as feedback.
- A handler may return `loop` with feedback. The run goes back to the step named in `loop.back_to`. `loop.max` caps those loops for the whole run, and core fails the run when a step asks for one more.
- The labeled-issue path loads the template whose `label` matches the issue label. The workflow only starts on `thin-pr`, so the Action runs `small-feature`.
- The same issue text, template, and model replies produce the same log, so `replay` can fold that log back into the final state: outputs, loops, and usage.

The orchestrator in `packages/github` is the caller. It runs `verify`, posts the checks, pushes the branch, and either opens the draft or comments the run report. Moving that code into the control plane would put the GitHub client on the wrong side of the boundary.

## Specialist contract

Four model specialists are fixed: `planner`, `implementer`, `reviewer`, and `pr-writer`. Each specialist has a Zod input schema and a Zod output schema, both `.strict()`. `createStepHandlers` turns each one into a step handler. The handler parses the input, calls the model, then parses the output. A bad value throws `SpecialistSchemaError` with the specialist name, the phase, and the path of the first issue. The step then uses its remaining retries or fails.

`ModelClient.complete` takes the specialist name and a prompt, and returns a string. The specialist parses that string as JSON. The default client is `ReplayModelClient`. It returns the override you passed, or the built-in fixture for that specialist. `createModelClient` returns that client unless `THIN_PR_MODEL` is `live`. The live client is `AnthropicModelClient` in `packages/specialists/src/live.ts`. It stays out of `packages/core`.

The prompt sent to the client is JSON with the step input and the feedback from a retry or a loop. The control plane never sees the prompt.

A table in `packages/specialists/src/specialists.ts` maps the steps `plan`, `implement`, `review`, and `write` onto those four specialists. The run log stores each parsed output. The gate and the draft body read those outputs. They do not read the model text a second time.

## Workspace and verify

A run edits one git checkout through the `Workspace` interface in `packages/specialists/src/workspace.ts`. `packages/workspace` implements it over a local checkout whose HEAD is the base commit. `createFile` refuses a path outside the `.thin-pr.yml` allow list or inside the deny list. `replace` needs the old text to match exactly once. Until the implementer edits through tools, `packages/github/src/steps.ts` writes each file the implementer returns as a new file or a full replace.

`verify` takes no model. It runs `typecheck` and then `test` from `.thin-pr.yml`, each through `/bin/sh` in its own process group with a timeout. The environment drops every variable whose name contains `TOKEN`, `KEY`, `SECRET`, or `PASSWORD`, and every `GITHUB_` and `ANTHROPIC_` variable. A failed check loops back to implement with the command and the last 4 KB of its output. `context.loop` counts the passes over verify, and verify stops asking for a loop once it reaches the template's `loop.max`. That last pass finishes with the failed check, so the gate names it instead of core failing the run at the cap.

## Gate rules

`evaluate()` always returns nine results, in this order. Each rule is a pure function of the evidence: the plan and review outputs, a valid flag per step contract, the workspace `Diff`, the check results, and the repo config.

| Rule | Pass | Fail |
| --- | --- | --- |
| `plan` | The planner output parses, and `steps` has at least one entry. | The plan is missing, or it does not match the planner schema. |
| `contracts` | Every template step output matches its schema. | No output was checked, or one output is missing or invalid. |
| `diff` | `git diff` against the base has a file, and `git diff -w` still has one. | The diff was not measured, it is empty, or only whitespace changed. |
| `budget` | The file count and the added plus removed lines are within `budget` in `.thin-pr.yml`. | The diff is missing, or it exceeds the file or line limit. |
| `paths` | Every changed path matches `paths.allow` and none matches `paths.deny`. | A changed path is denied or outside the allow list. |
| `secrets` | No added line looks like a private key, an AWS access key id, a GitHub token, an Anthropic key, a Slack token, or a `password`, `secret`, or `token` assigned a quoted string of 12 or more characters. | A finding names the file, the line, and the kind. It never includes the value. |
| `typecheck` | The typecheck command exited 0. | It did not run, or it exited non-zero. |
| `tests` | The test command exited 0. | It did not run, or it exited non-zero. |
| `review` | The reviewer output has `verdict: "approve"`, or it has no verdict and no notes. | The review is missing, it requests changes, or it has notes. |

`decide(evidence)` returns `pass` only when all nine verdicts are `PASS`. A run that reaches the gate always passes `plan` and `contracts`, because each model step parses its output with the same schemas. Those two rules guard evidence that comes from somewhere other than a finished run.

The gate is not a step. The orchestrator evaluates it after `write` finishes. Each rule posts a check named `thin-pr / gate / <rule>`. The title is the verdict. The summary is the verdict, a colon, and the reason. If any rule fails, the run is blocked. The orchestrator comments `## Run report` on the issue with the error `gate failed:` and the failed rule names, and pushes nothing.

If every rule passes, the orchestrator commits the checkout and runs `git push --force-with-lease` to `thin-pr/<issue>`. The lease is the remote-tracking ref from the checkout, so a branch that moved after the fetch is not overwritten. Then it opens a draft, or updates the body of the open pull request for that branch. The title is the pr-writer `title`, or `thin-pr #<issue number>` when that field is absent. The body is assembled in `formatDraftBody`: `## Plan`, `## Checks`, then `## Run report`. The pr-writer `body` field is not that text.

## Replay evals

`pnpm eval` does not call a live model and does not call GitHub. For each directory in `evals/cases` it copies `evals/sample-repo` into a scratch git repo with a bare `origin`, replays the recorded model replies, writes the recorded files through the workspace, and copies `hidden/*.test.ts` into `test/hidden/` right before verify. `.git/info/exclude` keeps the hidden tests out of the diff and the commit. The checks are the real `tsc --noEmit` and `vitest run`, found on `PATH` in this repo's `node_modules/.bin`.

Each case has an `expected.json` with the verdict and, for most blocked cases, the gate rules that must fail. Eight cases open a draft. Nine are blocked: one per rule from `diff` to `review`, a second budget case, and `10-empty-plan`, which fails at the plan step. The floor in `evals/baseline.json` is 100% verdict accuracy. The process exits 1 when the accuracy is lower.

CI runs `pnpm eval` after the tests. Lowering `evals/baseline.json` to make a red run green hides the regression the file is there to catch.

## Traces and the judge

`runWorkflow` opens a span for the run and one for each pass over a step with `@opentelemetry/api`. A process that never starts the SDK records nothing. `packages/github` starts the SDK for `pnpm trace` and for the labeled-issue Action. The exported document is OTLP JSON. The sample is `docs/demo/trace.json`.

The judge scores a finished replay. `decide()` still chooses the draft. `pnpm eval:judge` replays the 17 cases and applies the rubric in `packages/specialists/src/judge.ts` to each run's recorded replies, diff, and check results. The live client in that package runs when `THIN_PR_JUDGE` and `THIN_PR_MODEL` are both `live` and `ANTHROPIC_API_KEY` is set.

## Non-goals

- CI and `pnpm eval` do not call a live model. The live client runs only when `THIN_PR_MODEL=live` and `ANTHROPIC_API_KEY` is set, and it stays in `packages/specialists`.
- The Action pushes `thin-pr/<issue>` only after the gate passes. `pnpm eval` pushes to a scratch bare repo, never to GitHub.
- A check can read the push credentials that `actions/checkout` stores in `.git/config`. The scrubbed environment does not cover them.
- The Action does not merge the pull request, request reviewers, or close the issue.
- There is no chat UI, no second orchestrator, and no general agent loop.
- `packages/core` does not grow a model SDK import or a GitHub client import. `.agents/skills/core-boundary` is the list.
