# Gate

The gate decides whether a run opens a draft, waits for a person to approve it, or stops. It reads what the run produced and measured, not what the model says it did. `packages/gate/src/index.ts` holds the rules.

## How it runs

`runIssue` in `packages/github` builds the evidence after `write` finishes:

- `plan` and `review`: the parsed outputs of those steps.
- `contracts`: one entry per template step, valid when its output matches the step's Zod schema.
- `diff`: `workspace.diff()`, which is `git diff` against the base commit, file counts from `--numstat`, and a second pass with `--ignore-all-space`.
- `checks`: the `typecheck` and `test` results of the last `verify` pass.
- `budget`: `max_files` and `max_lines` from the template, with each field `.thin-pr.yml` sets in its place. `runLimits` in `packages/github/src/run.ts` merges them.
- `config`: `.thin-pr.yml` from the checkout, with defaults for every missing field.

`evaluate(evidence)` returns nine results in a fixed order. Each result has a `rule`, a `verdict`, and a `reason`. The verdict is `PASS` or `FAIL`, and the `budget` rule can also return `NEEDS_APPROVAL`. Every rule is a pure function of the evidence, so `packages/gate/src/index.test.ts` tests each one without a checkout.

`decide(evidence)` returns one of three decisions. `decideResults(results)` gives the same decision for results that were stored, such as the gate in a RunRecord.

| Decision | When | What `runIssue` does | Run status |
| --- | --- | --- | --- |
| `pass` | All nine rules pass. | Pushes `thin-pr/<issue>`, posts one check per rule on the new commit, and opens a draft or updates the open one. | `opened` |
| `needs_approval` | `budget` is `NEEDS_APPROVAL` and the other eight pass. | Pushes `thin-pr/<issue>` and posts the rule checks on the new commit, with `budget` as a neutral check. Opens no draft. Comments the run report with the changed files and the command to approve. | `awaiting_approval` |
| `fail` | Any rule fails. | Posts the rule checks on the base commit, comments the run report, and pushes nothing. | `blocked` |

A run that stops before the gate, such as a step that runs out of retries or a model call that could pass `spend_usd`, has status `failed` and no gate results.

## Rules

| Rule | Reads | Fails when | Eval case that trips it |
| --- | --- | --- | --- |
| `plan` | the plan output | The plan is missing or does not match the planner schema. | None. See below. |
| `contracts` | the contract flags | No step output was checked, or one is missing or invalid. | None. See below. |
| `diff` | the diff | The diff was not measured, it is empty, or only whitespace changed. | `16-whitespace-only` |
| `budget` | the diff and the run budget | The diff was not measured, or it is over the budget while another rule fails. Over the budget with every other rule passing is `NEEDS_APPROVAL`. | `21-document-every-helper` asks for approval. |
| `paths` | the diff and `paths` | A changed path matches `paths.deny`, or matches no `paths.allow` glob. Deny wins. | `14-denied-path`, `py-04-project-config` |
| `secrets` | the diff patch | An added line looks like a credential. | `15-planted-secret`, `py-05-planted-secret` |
| `typecheck` | the checks | The typecheck command did not run or exited non-zero. | `13-type-error` |
| `tests` | the checks | The test command did not run or exited non-zero. | `09-failing-hidden-test`, `py-03-failing-hidden-test` |
| `review` | the review output | The review is missing, does not match the reviewer schema, or requests changes. | `17-review-notes` |

The budget comes from the template, and `.thin-pr.yml` can override each field. The default `.thin-pr.yml` allows `src/**`, `test/**`, `examples/**`, `README.md`, and `docs/**`, and denies `.github/**`, `**/.env*`, `pnpm-lock.yaml`, and `package-lock.json`.

### `diff`

`16-whitespace-only` changes only whitespace in `src/counter.ts`. `git diff` counts four changed lines, and `git diff --ignore-all-space` has none, so the reason is `Diff only changes whitespace.`

### `budget`

The rule counts changed files and added plus removed lines from `--numstat`. It has three outcomes.

- `PASS`: both counts are within `max_files` and `max_lines`. An empty diff passes this rule, and the `diff` rule fails it. Only one rule names a problem.
- `NEEDS_APPROVAL`: a count is over its limit and the other eight rules pass. The change may be right but too big to review in one pass, so a person decides. The reason is the same text as a failure, such as `Diff exceeds the budget (13 files, 79 lines; limit 12 files, 600 lines).`
- `FAIL`: the diff was not measured, or a count is over its limit and another rule also fails. An approval only answers the size, and a change that fails another rule has nothing to approve.

`21-document-every-helper` changes 13 files, one more than the `feature` budget allows, and passes every other rule. It ends `awaiting_approval`. `11-wide-touch` adds one line to each of four files, and `12-long-readme` changes 31 lines in one file. Both fit the budget and open a draft.

The template budgets are placeholders: `feature` 12 files and 600 lines, `bugfix` 6 and 250, `docs` 8 and 400. The real-repo eval will measure what size of change lands reliably, and the defaults will be set from that data.

### Approving a run

The `awaiting_approval` comment ends with a hidden marker that stores the run: the RunRecord without the patch, the pushed branch, the commit the gate measured, the base branch, the draft title, and the plan and review outputs. `readStoredRun(body)` in `packages/github/src/approval.ts` reads it back. Anyone can write a marker, so the caller reads only comments the thin-pr app or workflow posted.

`openApprovedDraft(stored, { github, approvedBy })` opens the draft. It re-checks three things first, and refuses with a reason when one fails.

1. The stored run is `awaiting_approval`.
2. `decideResults` over the stored gate results is still `needs_approval`.
3. The branch still points at the commit the gate measured. A push after the run adds commits nobody gated.

The draft body is the run report with `Gate passed with approval.` and the approver's login. An open pull request for the branch gets the new body instead of a second draft. The function comments nothing. The command that calls it, `/thin-pr approve` from a user with write access, is not built yet.

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
