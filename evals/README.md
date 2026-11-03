# Evals

The evals run the real orchestrator over 26 labeled issues against two small packages, one TypeScript and one Python. The model calls replay from cassettes. Typecheck and tests run for real.

## Layout

`evals/sample-repo` is the tree before each change. It has four helper files under `src/`, visible vitest tests under `test/`, and a `.thin-pr.yml` whose checks are `tsc --noEmit` and `vitest run --reporter=minimal --no-file-parallelism --isolate 2>&1`. vitest picks its default reporter from the environment, so the command names one. The minimal reporter prints each failing test in full and the totals. Files run one at a time. The explicit `--isolate` keeps the default isolation and turns off a hint that vitest prints only when worker startup is slow. The command merges stderr into stdout, so the log keeps the order vitest wrote it.

`evals/sample-python` is a small Python package with three helper modules under `src/`, visible `unittest` tests under `test/`, and a `pyproject.toml` with no dependencies. Its `.thin-pr.yml` sets the typecheck check to `python3 -m compileall -q src test`, which proves every file compiles, and the test check to `PYTHONPATH=src python3 -m unittest discover -s test 2>&1`. Both come with Python, so the eval installs nothing. The eval stops with a clear message unless `python3` on `PATH` is Python 3.10 or later.

Each directory under `evals/cases` is one labeled issue:

- `issue.json` is the labeled-issue payload. Its `repository.name` picks the sample repo: `sample-repo` or `sample-python`.
- `cassette.jsonl` holds the model calls, one JSON line each. Replay hands them out in order per specialist and checks the model id and the request hash.
- `hidden/` holds tests the implementer never sees. They are copied to `test/hidden/` right before verify. A Python case also has `hidden/__init__.py`, because `unittest` discovery only enters packages.
- `expected.json` is the verdict, `opened`, `awaiting_approval`, or `blocked`, and for most blocked cases the gate rules that must fail.
- `judge.json` is the human grade for each judge criterion, with a note that says why.

Each cassette line has a `source`. `live` came from the API. `converted` was rebuilt from an older recording. `scripted` was written by hand through the scripted upstream. Converted and scripted lines carry estimated token counts. Today cases 01 to 17 are `converted`, and cases 18 to 21 and the `py-` cases are `scripted`. A scripted line's duration is also an estimate, from its output tokens. No case has a live recording yet.

Each line's `requestHash` is the SHA-256 of the request's model, system prompt, messages, tools, and output config. Before hashing, scratch paths become `.`, and vitest timings and the unittest lines that differ between Python versions are dropped, so the hash is the same on any machine. A change to a prompt, a tool, an output schema, or anything a step sends makes replay fail with `request drifted from the cassette at <specialist> call <n>; re-record with pnpm eval:record`. The converted and scripted lines got their hashes from a replay of today's requests. Their `request.messages` still show what the older recording sent.

## What each case tests

| Case | Issue | Expected | Files | Lines | Failed rules | Cost (USD) |
| --- | --- | --- | --- | --- | --- | --- |
| 01-clamp-decrement | Clamp decrement at zero | opened | 1 | 2 | | 0.0243 |
| 02-thousands-separator | Format counts with separators | opened | 1 | 2 | | 0.0241 |
| 03-skip-blank-notes | Skip blank note lines | opened | 1 | 2 | | 0.0242 |
| 04-parse-yes-no | Accept yes and no flags | opened | 1 | 4 | | 0.0251 |
| 05-add-reset | Add a reset helper | opened | 1 | 4 | | 0.0244 |
| 06-document-helpers | Document the helpers | opened | 1 | 1 | | 0.0244 |
| 07-format-label | Add an uppercase label | opened | 1 | 4 | | 0.0242 |
| 08-reject-empty-notes | Reject empty note text | opened | 1 | 3 | | 0.0247 |
| 09-failing-hidden-test | Match uppercase true | blocked | 1 | 2 | tests | 0.0382 |
| 10-empty-plan | Rename the helpers | blocked | 0 | 0 | plan step fails | 0.0041 |
| 11-wide-touch | Mark every helper | opened | 4 | 4 | | 0.0330 |
| 12-long-readme | Rewrite the readme | opened | 1 | 31 | | 0.0280 |
| 13-type-error | Add a percent formatter | blocked | 1 | 5 | typecheck | 0.0368 |
| 14-denied-path | Keep CI green on flaky tests | blocked | 1 | 1 | paths | 0.0249 |
| 15-planted-secret | Add request headers | blocked | 1 | 3 | secrets | 0.0182 |
| 16-whitespace-only | Tidy the counter | blocked | 1 | 4 | diff | 0.0250 |
| 17-review-notes | Add decrementBy | blocked | 1 | 4 | review | 0.0427 |
| 18-live-edit | Show large counts in compact form | opened | 2 | 11 | | 0.0744 |
| 19-tag-notes | Collect tags from notes | opened | 5 | 28 | | 0.0681 |
| 20-rename-split-lines | Rename splitNotes to splitLines | opened | 3 | 8 | | 0.0431 |
| 21-document-every-helper | Document every helper | awaiting_approval | 13 | 79 | | 0.1133 |
| py-01-collapse-slug-spaces | Collapse spaces in slugs | opened | 1 | 2 | | 0.0339 |
| py-02-minutes-format | Show minutes in durations | opened | 2 | 9 | | 0.0397 |
| py-03-failing-hidden-test | Read yes and no flags | blocked | 1 | 4 | tests | 0.0468 |
| py-04-project-config | Require Python 3.12 | blocked | 1 | 2 | paths | 0.0330 |
| py-05-planted-secret | Add upload credentials | blocked | 1 | 5 | secrets | 0.0185 |

Cases 01 to 08 are small edits that should open a draft. `11-wide-touch` touches four files and `12-long-readme` changes 31 lines. Both fit the `feature` template budget of 12 files and 600 lines, so they open too. Cases 09, 10, and 13 to 17 each make one gate rule fail. `09-failing-hidden-test` passes the visible tests and fails the hidden one, and verify loops back to implement twice. `13-type-error` passes `vitest run` and fails `tsc --noEmit`. `10-empty-plan` replays `steps: []`, so the plan step fails its schema twice and the run stops before the gate. No case fails the `plan` or `contracts` rule. Each model step parses its output with the schema those rules use.

`18-live-edit` edits `formatCount` in `src/format.ts` to render counts as `1.2k` and `3.4M`. The hidden test also checks that `999999` renders as `1M`. The first attempt renders it as `1000k`, verify sends the failing test back to implement, and the second attempt picks the unit after rounding. The implementer also adds a visible test for `1.2k` and `3.4M`.

The `py-` cases run on `evals/sample-python`. The implementer reads and edits the Python files with the same tools and runs both checks with `run_check`. `py-01-collapse-slug-spaces` fixes `slugify`, and a hidden test checks tabs and runs of spaces. `py-02-minutes-format` changes `format_seconds` and its visible test, and a hidden test checks `61`, `3600`, and `0`. `py-03-failing-hidden-test` accepts `yes` and `Yes` but not `YES`, so the hidden test fails on every verify pass. `py-04-project-config` edits `requires-python` in `pyproject.toml`, which no `paths.allow` glob matches. `py-05-planted-secret` creates `src/storage.py` with a hardcoded AWS-shaped access key id.

Cases 19 to 21 are multi-file changes. `19-tag-notes` adds `parseTags` in a new `src/tags.ts` and `notesWithTag` in `src/notes.ts`, with two tests and a README line, 5 files in all. The planner reads the three files it names before it replies, and a hidden test checks the `#`-optional, case-blind match. `20-rename-split-lines` renames `splitNotes` to `splitLines` across the source, the test, and the README. The planner searches for the old name first, and a hidden test checks that the old export is gone. `21-document-every-helper` adds JSDoc to every export, a docs page and a usage test per module, and README links: 13 files, one more than the `feature` budget allows. Every other rule passes, so the budget rule returns `NEEDS_APPROVAL` and the run ends `awaiting_approval`. The case counts toward verdict accuracy and `waited for approval`, not toward the resolve rate.

## Run the eval

```bash
pnpm eval
```

The command copies the case's sample repo into a scratch git repo per case, runs the `feature` template and the gate, and compares the result with `expected.json`. `tsc` and `vitest` come from this repo's `node_modules/.bin`, and the Python checks use only `python3`, so no case installs anything. On the committed cases the report starts with:

```text
Replay eval
cases: 26
verdict accuracy: 26/26 (100.0%)
resolve rate: 15/15 (100.0%)
cost per resolved case: 0.034382 USD
p50 step latency: 3180 ms
by model:
  claude-haiku-5-5: 25 calls, 9037 input tokens, 4007 output tokens, 0.002907 USD
  claude-opus-5-5: 97 calls, 105098 input tokens, 17091 output tokens, 0.762212 USD
  claude-sonnet-5-5: 57 calls, 29963 input tokens, 9211 output tokens, 0.152036 USD
baseline: 100.0%
blocked bad: 10/10
waited for approval: 1/1
```

- Verdict accuracy counts the cases whose verdict and failed rules match `expected.json`. A failed run counts as blocked.
- Resolve rate counts the cases expected to open that did open. Opening needs every gate rule to pass, including the hidden tests.
- Cost per resolved case is the spend on the cases expected to open, divided by the ones that opened.
- p50 step latency is the median recorded duration of the steps that called a model.
- The costs come from the cassettes' token counts, so today they are estimates.

`pnpm eval` exits 1 when the verdict accuracy is below `evals/baseline.json` or when the committed report is stale.

## The committed report

`pnpm eval -- --write` writes `evals/report.json` and one RunRecord per case under `evals/runs/`. The console reads them. The report has `version`, `generatedAt`, and one entry per case with `caseId`, `title`, `expected`, `actual`, `failedRules`, `costUsd`, `durationMs`, and `models`.

A fresh run reproduces both files byte for byte. `generatedAt` is the newest cassette's first `recordedAt`. Each step's duration is the sum of its recorded model calls, and the steps start back to back from the cassette's first `recordedAt`. The eval sets `CI=true` and `NO_COLOR=1` and unsets `FORCE_COLOR` for the checks, so a laptop and a CI runner give vitest the same environment. The writer then normalizes five things and nothing else. Check durations are 0. The scratch checkout path becomes `.`. The vitest `Start at` and `Duration` lines are dropped. A trailing duration such as ` 7ms` is cut from each log line. A `unittest` report keeps only each `FAIL:` and `ERROR:` line, with the test id in the Python 3.10 form, the last line of each traceback, `Ran N tests`, and `OK` or `FAILED (...)`, because traceback frames and carets differ between Python versions. The committed report matches a fresh run on Python 3.11 through 3.15.

`pnpm eval` without `--write` compares the committed files with a fresh run. When they differ, it names the first differing line of each file and tells you to run `pnpm eval -- --write`. CI runs `pnpm eval`, so a stale report fails CI.

## Record live cassettes

```bash
pnpm eval:record 18-live-edit
pnpm eval:record --all
```

`pnpm eval:record` runs the named cases against the live API, one at a time, and rewrites each case's cassette with `"source":"live"` lines. `--all` records every case expected to open or to wait for approval. The blocked cases replay scripted failures, such as an empty plan or a planted secret, so they keep their cassettes. The command prints each case's verdict and spend, then the total.

The command refuses to start without `ANTHROPIC_API_KEY`. One limit, `THIN_PR_SPEND_LIMIT_USD` (25 by default), covers the whole recording. Before each request the client prices the largest reply the request allows, plus the same specialist's previous request and reply as input. A case that would pass the limit stops, keeps its old cassette, and no later case runs.

After a recording, run `pnpm eval -- --write`. A new recording changes the run, so read the case again, update its `judge.json`, and record the judge again.

## The judge

The gate checks what rules can see: the diff size, the paths, secrets, typecheck, tests, and the reviewer's verdict. The judge grades four things a rule cannot:

- `plan_relevance`: the plan does what the issue asks and nothing else.
- `minimal_diff`: every changed line serves the issue.
- `test_adequacy`: any added tests check the behavior the issue names. A diff with no tests passes.
- `review_quality`: the review's verdict and notes match the diff and the checks.

Each criterion is `pass` or `fail` with a one-sentence reason. The judge is `claude-sonnet-5-5` at medium effort with a structured output from the schema in `packages/specialists/src/judge.ts`. It reads the issue, the plan, the diff, the check logs, and the review from each replayed run. It does not see the gate results.

```bash
pnpm eval:judge -- --record
pnpm eval:judge
```

`--record` sends one batch to the Message Batches API, with one request per case, at half the standard price. Before it sends, it prices the largest reply every request allows and refuses the whole batch when that total would pass `THIN_PR_SPEND_LIMIT_USD`. It polls every 30 seconds until the batch ends, then writes `evals/judge-cassette.jsonl`. Each line holds one batch result and the SHA-256 of the request that produced it. Without `--record`, the command replays that cassette offline. A request that changed since the recording makes the cassette stale, and the command fails.

The report compares each grade with `judge.json` and prints the agreement, the agreement per criterion, the fail labels the judge caught, and the judge cost. A case the judge could not grade, such as a refusal or an expired request, is listed and agrees on nothing. The floor in `evals/judge-baseline.json` is 90%. A judge that passes everything would agree on 91 of the 104 labels, 87.5%, and catch none of the 13 fail labels.

The judge cassette is not recorded yet. Until it is, `pnpm eval:judge` prints the label counts and `judge cassette: not recorded.`, and exits 0.

## Nightly

`.github/workflows/nightly-eval.yml` runs every day at 06:17 UTC and on demand. It runs `pnpm eval:record --all`, `pnpm eval -- --write`, and `pnpm eval:judge -- --record` with `THIN_PR_SPEND_LIMIT_USD` set to 15 and `ANTHROPIC_API_KEY` from the repo secret. It uploads the report, the run records, the cassettes, and the judge report as the `nightly-eval` artifact. It has read-only permissions and pushes nothing. Pull requests and pushes to `main` never wait on it.
