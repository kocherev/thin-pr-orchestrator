# One issue, end to end

This follows one real run on [kb-copilot](https://github.com/kocherev/kb-copilot), a Python and TypeScript monorepo that thin-pr had never seen. Its owner wrote an issue, labelled it, reviewed thin-pr's draft, and merged it. Every screenshot is from that repo's public pages.

## 1. The owner labels an issue

[Issue #44](https://github.com/kocherev/kb-copilot/issues/44) describes a bug in the eval script: `--limit 0` and negative limits look like successful runs. The owner adds the label `thin-pr:bugfix`. That picks the bugfix template, with a budget of 6 files and 250 changed lines.

When the run starts, thin-pr posts one progress comment on the issue and edits it as each step finishes. When the run ends, the comment becomes the report below. All nine gate rules passed, the draft is #46, and the run cost $0.15.

![Issue #44 with the thin-pr:bugfix label, and thin-pr's report: all 9 gate rules passed, draft #46, and the spend per model](demo/end-to-end/01-issue.png)

The report shows what each model did:
- Sonnet 5.5 planned and reviewed, in 9 requests for $0.087.
- Opus 5.5 wrote the change, in 4 requests for $0.067.
- Haiku 5.5 titled the draft, in 1 request for $0.0001.

The two checks are the repo's own commands, and both passed. Typecheck ran lint, tsc, ruff and pyright. Test ran the web tests and pytest.

## 2. The Action runs

The label starts the Thin PR workflow, which runs the Action from `action.yml`. The whole job took 5 minutes 10 seconds, including the repo's installs. It uploaded the run's OpenTelemetry trace as an artifact.

![The Thin PR workflow run: triggered by the label on #44, Success in 5m 10s, and the thin-pr-trace artifact](demo/end-to-end/02-run.png)

Inside the job, the repo's install and checks run as a second user, `thin-pr-check`. Code the model wrote can't read the API key or the push token from any process, and it can't plant a git hook. CI proves this on a real runner with a canary secret. `docs/security.md` has the details.

## 3. The draft and its gate

thin-pr pushed `thin-pr/44` and opened a draft. The gate's nine rules show as checks on that commit. thin-pr never puts a check on the repo's main branch, so a blocked run can't make main look broken.

![The draft's checks: thin-pr / gate / budget, contracts, diff, paths, plan, review, secrets, tests and typecheck, all passed](demo/end-to-end/03-checks.png)

The change is two lines in `answers.py`, plus a test written in the style of the file around it. It also asserts that no output file is written, which the issue asked for.

![The draft's diff: a two-line check in answers.py, and a parametrized test in test_answers.py, +26 −1](demo/end-to-end/04-diff.png)

## 4. The owner merges

The owner read the diff, marked the draft ready, and merged it. The owner's hidden acceptance test, which thin-pr never saw, passes 4 of 4 on it.

![The timeline: the bot's commit, the owner marking it ready for review, and the merge with 16 checks passed](demo/end-to-end/05-merge.png)

This was one of six. thin-pr opened a draft for every issue the owner labelled, and the owner merged all six. For two of them, an earlier run failed first. The numbers below cover those runs. Five drafts needed no human edit. The sixth, #39, needed one commit to regenerate an API client, which thin-pr now does itself with an allowlisted generator.

![kb-copilot's merged pull requests by github-actions: all six thin-pr drafts, each with its checks passing](demo/end-to-end/06-merged-drafts.png)

## 5. Behind every run

Each run writes a record: every step, its model calls, tokens, cost and timing, the gate results, and the diff. The console is a static site over those records. Here it shows `19-tag-notes`, a 5-file change from the replayed eval:
- the gate rules
- the checks
- one timeline for the five steps, each with its model and cost

![Console run page for 19-tag-notes: 9 of 9 gate rules, both checks passed, and a step timeline with each step's model, requests and cost](demo/end-to-end/07-console-run.png)

The eval runs 26 issues with known right answers, on a TypeScript and a Python sample repo. Fifteen should open a draft. One goes over its size budget and must wait for approval. Ten must be stopped. They cover a type error, failing hidden tests, denied paths, planted secrets, a whitespace-only diff, review notes, and an empty plan. thin-pr gets all 26 right.

![Console eval page: verdict accuracy 100%, resolve rate 100%, $0.034 per resolved case, and each case's expected and actual result](demo/end-to-end/09-console-evals.png)

![Console runs list: 15 opened, 1 waiting for approval, 10 stopped, with the gate result, cost and duration of each](demo/end-to-end/08-console-runs.png)

Each run is also one OpenTelemetry trace. There's one span per step, with the model requests and tool calls nested inside. Each request span carries its tokens and cost.

![Jaeger trace: one span per step, with model request and tool spans nested under each](demo/trace-jaeger.png)

## The numbers

On kb-copilot, a real repo, with the owner as judge:

| | Stage 1: local runs | Stage 2: the Action on GitHub |
| --- | --- | --- |
| Issues | 10 | 6 |
| Owner verdict | 10 of 10 correct | 6 of 6 drafts merged, 5 with no human edit |
| Hidden acceptance tests | 9 of 10 pass. The one miss was the test's fault. | Pass on every draft the owner ran them on |
| Spend | $2.49 for all ten | $1.69 for the six drafts |
| Time per issue | 18 to 160 seconds | 4 to 8 minutes, including installs and checks |

Three stage 2 runs failed along the way, for $2.78 in total. Each one led to a fix that is now merged. `evals/kb-copilot/README.md` lists every issue, every diff, and what each stage changed in thin-pr.

On the replayed eval of 26 issues, thin-pr gets 26 of 26 verdicts right and resolves 15 of 15, for $0.034 per resolved case. Those costs come from replayed recordings, so they are estimates.

Before any push, `pnpm ci:local` runs every CI job:
- gitleaks
- the full check in a Linux container
- the sandbox test as a real second user
- the Action's fresh install
- the console and deploy builds
