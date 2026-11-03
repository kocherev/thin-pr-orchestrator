# Working notes

Thin PR Orchestrator. Read this before changing the repo. It is enough to install and run the six checks below. The public overview is `README.md`. The design is in `docs/architecture.md`, `docs/gate.md`, and `docs/security.md`.

## Requirements

- Node.js 22.13 or later. `.nvmrc` contains `22`.
- pnpm 10.33.4, from the `packageManager` field in `package.json`. Do not switch to another major version.
- A checkout of this repo.
- git 2.28 or later. The tests, `pnpm eval`, and `pnpm trace` create scratch git repos.
- Python 3.10 or later as `python3`, for the eval cases on `evals/sample-python`. They use only the standard library.

Corepack ships with Node 22. Enable it when `pnpm` is missing or the version is not 10.33.4.

```bash
corepack enable
corepack prepare pnpm@10.33.4 --activate
```

`node:sqlite` is available without a flag on Node 22.13 and later. It is still experimental on the Node 22 line. `vitest.config.ts` passes `--experimental-sqlite` for the test workers. `pnpm eval` does not pass that flag.

## Install

From the repo root:

```bash
pnpm install
```

You do not need `.env` for lint, typecheck, test, or eval. Copy `.env.example` to `.env` only when you are setting `GITHUB_TOKEN` yourself. Do not commit `.env` or a real token.

## Commands

Run these from the repo root, in this order, after `pnpm install`. Each one exits 0 when it passes. Read the output. A command you did not run is not a pass. `pnpm verify` runs all six in this order and stops at the first failure.

### pnpm lint

Runs `eslint .`, then `node --experimental-strip-types scripts/check-core-boundary.ts`.

ESLint bans model-client imports and GitHub client imports in `packages/core`. It also bans GitHub client imports in `packages/specialists`, `packages/gate`, `packages/workspace`, `packages/mcp`, and `scripts`. The script scans `packages/core` for `require()` and dynamic `import()` of the same model clients. Either failure exits non-zero. The banned names are listed in `.agents/skills/core-boundary`.

### pnpm typecheck

Runs `tsc -b --pretty false`. This is the same compiler pass as `pnpm build`. `pnpm build` also writes `dist/` in each project. Typecheck does not write that output. A type error fails both.

### pnpm test

Runs `vitest run`. The config is `vitest.config.ts`, with two projects. The `node` project runs `packages/*/src/**/*.test.ts`, `packages/app/runner/*.test.ts`, `scripts/**/*.test.ts`, and `apps/console/lib/**/*.test.ts`. Its workers get `--experimental-sqlite` and `--disable-warning=ExperimentalWarning`, and each test and hook gets 60 seconds. The second project is `packages/app/vitest.config.ts`, which runs the Worker tests in the Workers runtime.

Useful single files:

```bash
pnpm exec vitest run packages/core/src/run.test.ts
pnpm exec vitest run packages/github/src/run.test.ts
pnpm exec vitest run packages/specialists/src/client.test.ts
pnpm exec vitest run scripts/eval.test.ts
```

`packages/core/src/run.test.ts` writes a SQLite log for a run that loops once, reopens it, and expects `replay` to rebuild the same outputs, loops, and usage. `packages/github/src/run.test.ts` runs `fixtures/sample-issue-labeled.json` against a scratch git checkout with an in-memory GitHub client. `packages/specialists/src/client.test.ts` records and replays model calls against a fake API and checks pricing, the spend limit, and refusals. `packages/workspace/src/git.test.ts` edits, diffs, checks, and pushes a scratch checkout. `scripts/eval.test.ts` runs the eval, expects 26/26, and checks that the committed report matches the run. `scripts/record.test.ts` records a case through the scripted upstream and checks the spend limit. `scripts/judge.test.ts` checks the human labels and records and replays a judge batch through the scripted upstream. `scripts/trace.test.ts` expects 16 spans in one trace, with the GenAI attributes, the parent links, request costs that match the pricing, and no prompt or file text. It also sends the spans to a local OTLP receiver.

`scripts/eval.test.ts`, `scripts/record.test.ts`, and the replay test in `packages/mcp/src/server.test.ts` run `tsc` and `vitest` in scratch repos for several cases. They set longer timeouts of their own.

### pnpm eval

Runs `node --disable-warning=ExperimentalWarning --import tsx scripts/eval.ts`.

Stdout on the committed cases starts with:

```text
Replay eval
cases: 26
verdict accuracy: 26/26 (100.0%)
resolve rate: 15/15 (100.0%)
cost per resolved case: 0.034382 USD
p50 step latency: 3180 ms
```

The command then prints the totals by model, the baseline, the gate rules some case fails, and one line per case: id, `opened`, `awaiting_approval`, or `blocked`, `ok` or `MISMATCH`, file count, line count, and the failed rules, the rule that needs approval, or the step error. Each case runs on a scratch git copy of the sample repo its issue names, `evals/sample-repo` or `evals/sample-python`, with this repo's `node_modules/.bin` on `PATH` for `tsc` and `vitest`. The Python cases need `python3` 3.10 or later on `PATH` and nothing else. The eval stops with a message that says so when it is missing. Exit 0 means the verdict accuracy is at least `evals/baseline.json` and `evals/report.json` and `evals/runs/` match the run.

When you change a case, a cassette, or anything a run records, run `pnpm eval -- --write` and commit `evals/report.json` and `evals/runs/` in the same change. Do not lower `evals/baseline.json`, and do not edit `scripts/eval.test.ts`, to turn a red eval green. Update the case table in `evals/README.md` when a case changes, and the results table in `README.md` when the printed numbers change.

### pnpm eval:record

Runs `node --disable-warning=ExperimentalWarning --import tsx scripts/record.ts`. It is not part of `pnpm verify`.

`pnpm eval:record <caseId>` or `pnpm eval:record --all` runs cases against the live API and rewrites their cassettes. It needs `ANTHROPIC_API_KEY` in the environment and stops at `THIN_PR_SPEND_LIMIT_USD`, 25 by default. See `evals/README.md`.

### pnpm eval:judge

Runs `node --disable-warning=ExperimentalWarning --import tsx scripts/judge.ts`.

The command replays `evals/judge-cassette.jsonl` over the replayed eval and compares each grade with `evals/cases/<id>/judge.json`. Exit 0 means the agreement is at least `evals/judge-baseline.json`. The cassette is not recorded yet, so on the committed cases the command prints `judge cassette: not recorded.` and exits 0. `pnpm eval:judge -- --record` grades the runs in one message batch, with one request per case, and needs `ANTHROPIC_API_KEY`.

### pnpm trace

Runs `node --disable-warning=ExperimentalWarning --import tsx scripts/trace.ts`.

The command replays run `run-7` on a scratch checkout and exports OTLP JSON. Set `THIN_PR_TRACE_PATH` to write a file. With the variable empty, the JSON goes to stdout. With `OTEL_EXPORTER_OTLP_ENDPOINT` set, the spans go to that endpoint and no file is written. `docs/telemetry.md` has the backends and the attributes. `docs/demo/trace.json` is one file from this command. `@opentelemetry/sdk-node` 0.300.0 requires Node.js 22.15 or later.

## Layout

`packages/core` is the control plane. It runs the template, appends each step event to SQLite, and does not call a model. `packages/specialists` holds planner, implementer, reviewer, and pr-writer as step handlers, the `Workspace` interface, and `createAnthropicClient`. `THIN_PR_MODEL` is `live`, `record`, or `replay`. `replay` is the default, except in the labeled-issue Action, which defaults to `live` and fails the run when `ANTHROPIC_API_KEY` is missing. `record` and `replay` read the cassette path from `THIN_PR_CASSETTE`. `packages/workspace` is the git checkout a run edits: file tools, the check runner with a scrubbed environment and a timeout, `git diff` against the base, commit and push, and `.thin-pr.yml`. `packages/gate` evaluates plan, contracts, diff, budget, paths, secrets, typecheck, tests, and review. Each rule returns `PASS` or `FAIL` and a reason. `packages/github` is the only package that calls GitHub. It runs `verify`, posts the checks, and pushes `thin-pr/<issue>` and opens or updates a draft pull request when every gate rule passes. A failure comments the run report and pushes nothing. Specialists do not import it.

`pnpm thin-pr run` and the MCP server in `packages/mcp` run issues against a local checkout. See `docs/mcp.md`. `packages/app` is the GitHub App on Cloudflare. See `docs/deploy.md`. `apps/console` is the static console over `evals/runs/` and `evals/report.json`. `pnpm console:build` writes it to `apps/console/out`.

The YAML templates under `templates/` are data. A step names its id, optional model and effort, retry limit, and optional loop. The labeled-issue entry loads the template whose `label` matches the issue label.

`evals/` holds the TypeScript and Python sample repos and one directory per case under `evals/cases`. `pnpm eval` replays each case's `cassette.jsonl`. `fixtures/gate-pass.jsonl` and `fixtures/gate-fail.jsonl` are the cassettes for the draft path and the failed-rule path.

## Skills

Use ponytail and the working style on every change. Ponytail stops extra code. The working style says how to prove the code that remains.

- `.agents/skills/ponytail` for the smallest complete diff.
- `.agents/skills/working-style` for data shape, tests, and role budgets.
- `.agents/skills/core-boundary` for any edit under `packages/core` or to lint.
- `.agents/skills/prove-it-works` before calling a change done.
- `.agents/skills/typescript-best-practices` when editing `.ts` files. Tests and diff size stay with `.agents/skills/working-style`.
- `.agents/skills/technical-writing` when editing `README.md`, `docs/`, `AGENTS.md`, or pull request text.
- `.agents/skills/unslop` when editing that same public copy.
- `.agents/skills/make-interfaces-feel-better` and `.agents/skills/interface-catalog` when a change has UI.
- `.agents/skills/design-engineering` and `.agents/skills/design-catalog` when a change has motion or component feel.

## Commits and pull requests

- Write each commit subject as one imperative sentence in sentence case, such as `Run typecheck and tests on the pull request branch`. Do not use a conventional-commit prefix such as `feat:` or `fix:`. A plain-prose body is optional.
- Name the branch `feat/<slug>`, `fix/<slug>`, `refactor/<slug>`, `chore/<slug>`, or `docs/<slug>`.
- Open one pull request per change. Merge it with a squash merge.
- Merge only when CI is green.

## Hard rule

No model-client import in `packages/core`. ESLint and `scripts/check-core-boundary.ts` both fail the build on one. See `.agents/skills/core-boundary`. GitHub clients belong in `packages/github`.
