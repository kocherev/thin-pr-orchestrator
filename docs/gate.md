# Gate

The gate decides whether a run opens a draft. It reads what the run produced and measured, not what the model says it did. `packages/gate/src/index.ts` holds the rules.

## How it runs

`runIssue` in `packages/github` builds the evidence after `write` finishes:

- `plan` and `review`: the parsed outputs of those steps.
- `contracts`: one entry per template step, valid when its output matches the step's Zod schema.
- `diff`: `workspace.diff()`, which is `git diff` against the base commit, file counts from `--numstat`, and a second pass with `--ignore-all-space`.
- `checks`: the `typecheck` and `test` results of the last `verify` pass.
- `config`: `.thin-pr.yml` from the checkout, with defaults for every missing field.

`evaluate(evidence)` returns nine results in a fixed order. Each result has a `rule`, a `verdict` of `PASS` or `FAIL`, and a `reason`. `decide(evidence)` returns `pass` only when all nine pass. Every rule is a pure function of the evidence, so `packages/gate/src/index.test.ts` tests each one without a checkout.

When `decide` returns `fail`, `runIssue` posts a failed check per rule on the base commit, comments the run report on the issue, and pushes nothing. The run's status is `blocked`. A run that stops before the gate, such as a step that runs out of retries, has status `failed` and no gate results.

## Rules

| Rule | Reads | Fails when | Eval case that trips it |
| --- | --- | --- | --- |
| `plan` | the plan output | The plan is missing or does not match the planner schema. | None. See below. |
| `contracts` | the contract flags | No step output was checked, or one is missing or invalid. | None. See below. |
| `diff` | the diff | The diff was not measured, it is empty, or only whitespace changed. | `16-whitespace-only` |
| `budget` | the diff and the run budget | The file count or the added plus removed lines pass `max_files` or `max_lines`. | None. See below. |
| `paths` | the diff and `paths` | A changed path matches `paths.deny`, or matches no `paths.allow` glob. Deny wins. | `14-denied-path`, `py-04-project-config` |
| `secrets` | the diff patch | An added line looks like a credential. | `15-planted-secret`, `py-05-planted-secret` |
| `typecheck` | the checks | The typecheck command did not run or exited non-zero. | `13-type-error` |
| `tests` | the checks | The test command did not run or exited non-zero. | `09-failing-hidden-test`, `py-03-failing-hidden-test` |
| `review` | the review output | The review is missing, does not match the reviewer schema, or requests changes. | `17-review-notes` |

The budget comes from the template, and `.thin-pr.yml` can override each field. The default `.thin-pr.yml` allows `src/**`, `test/**`, `examples/**`, `README.md`, and `docs/**`, and denies `.github/**`, `**/.env*`, `pnpm-lock.yaml`, and `package-lock.json`.

### `diff`

`16-whitespace-only` changes only whitespace in `src/counter.ts`. `git diff` counts four changed lines, and `git diff --ignore-all-space` has none, so the reason is `Diff only changes whitespace.`

### `budget`

`11-wide-touch` adds one line to each of four files, and `12-long-readme` changes 31 lines in one file. Both fit the `feature` budget of 12 files and 600 lines and open a draft. `packages/gate/src/index.test.ts` covers the failure.

### `paths`

`14-denied-path` edits `.github/workflows/ci.yml` with the `replace` tool. `replace` edits any existing file in the checkout, so the edit lands. The gate then fails with `Changed paths are not allowed: .github/workflows/ci.yml (denied).` `create_file` refuses a denied path before writing.

### `secrets`

The scanner in `packages/gate/src/secrets.ts` reads only the lines the patch adds. It looks for a private key header, an AWS access key id, a GitHub token, an Anthropic API key, a Slack token, and `password`, `secret`, or `token` assigned a quoted string of 12 or more characters. A finding names the file, the line in the new file, and the kind. It never includes the matched text. `15-planted-secret` creates `src/client.ts` with an Anthropic-shaped key on line 2, and the reason is `Added lines look like secrets: src/client.ts:2 (Anthropic API key).`

### `typecheck` and `tests`

Both read the last `verify` pass. `13-type-error` passes `vitest run` and fails `tsc --noEmit` with exit 2. `09-failing-hidden-test` passes the visible tests and fails a hidden test that the eval copies in before `verify`. Verify loops back to implement twice, the recorded implementer makes no further edit, and the last pass hands the failure to the gate.

### `review`

The rule follows the reviewer's `verdict`, not the number of notes. `17-review-notes` requests changes on every pass. Review loops back to implement twice, then finishes, and the gate fails with `Reviewer requested changes (1 note).`

### `plan` and `contracts`

No eval case fails these two rules. Each model step parses its output with the same schema these rules use, so a run that reaches the gate passes both. They guard evidence that comes from somewhere other than a finished run. `packages/gate/src/index.test.ts` covers their failures. `10-empty-plan` fails one step earlier. The planner replays `steps: []`, the plan step fails its schema on both attempts, and the run fails before the gate.

## What the gate does not judge

The rules check what code can measure. They do not ask whether the plan fits the issue, whether every changed line serves it, or whether added tests check the right behavior. The judge grades those offline against human labels. `evals/README.md` describes it.
