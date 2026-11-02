# Working notes

Thin PR Orchestrator. Read this before changing the repo. It is enough to install and run the four checks below. The public overview is `README.md`. The why is `docs/design.md`.

## Requirements

- Node.js 22.13 or later. `.nvmrc` contains `22`.
- pnpm 10.33.4, from the `packageManager` field in `package.json`. Do not switch to another major version.
- A checkout of this repo.
- git 2.28 or later. The tests, `pnpm eval`, and `pnpm trace` create scratch git repos.

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

ESLint bans model-client imports and GitHub client imports in `packages/core`. It also bans GitHub client imports in `packages/specialists`, `packages/gate`, and `scripts`. The script scans `packages/core` for `require()` and dynamic `import()` of the same model clients. Either failure exits non-zero. The banned names are listed in `.agents/skills/core-boundary`.

### pnpm typecheck

Runs `tsc -b --pretty false`. This is the same compiler pass as `pnpm build`. `pnpm build` also writes `dist/` in each project. Typecheck does not write that output. A type error fails both.

### pnpm test

Runs `vitest run`. The config is `vitest.config.ts`. Workers get `--experimental-sqlite` and `--disable-warning=ExperimentalWarning`. Included files are `packages/*/src/**/*.test.ts` and `scripts/**/*.test.ts`.

Useful single files:

```bash
pnpm exec vitest run packages/core/src/run.test.ts
pnpm exec vitest run packages/github/src/run.test.ts
pnpm exec vitest run packages/specialists/src/client.test.ts
pnpm exec vitest run scripts/eval.test.ts
```

`packages/core/src/run.test.ts` writes a SQLite log for a run that loops once, reopens it, and expects `replay` to rebuild the same outputs, loops, and usage. `packages/github/src/run.test.ts` runs `fixtures/sample-issue-labeled.json` against a scratch git checkout with an in-memory GitHub client. `packages/specialists/src/client.test.ts` records and replays model calls against a fake API and checks pricing, the spend limit, and refusals. `packages/workspace/src/git.test.ts` edits, diffs, checks, and pushes a scratch checkout. `scripts/eval.test.ts` runs the eval and expects 17/17. `scripts/judge.test.ts` expects the judge report at 12/17. `scripts/trace.test.ts` expects six span names in the OTLP file.

The eval and judge tests run `tsc` and `vitest` in scratch repos, so each takes tens of seconds. They set their own timeouts.

### pnpm eval

Runs `node --disable-warning=ExperimentalWarning --import tsx scripts/eval.ts`.

Stdout on the committed cases starts with:

```text
Replay eval
cases: 17
verdict accuracy: 17/17 (100.0%)
baseline: 100.0%
opened good: 8/8
blocked bad: 9/9
rules failed by a case: diff, budget, paths, secrets, typecheck, tests, review
rules no case fails: plan, contracts
```

The command then prints one line per case: id, `opened` or `blocked`, `ok` or `MISMATCH`, file count, line count, and the failed rules or the step error. The full table is in `README.md`. Each case runs on a scratch git copy of `evals/sample-repo`, with this repo's `node_modules/.bin` on `PATH` for `tsc` and `vitest`. Exit 0 means the verdict accuracy is at least `evals/baseline.json`.

Do not lower `evals/baseline.json`, and do not edit `scripts/eval.test.ts`, to turn a red eval green. If you change a case, update the README table in the same change and keep the test honest.

### pnpm eval:judge

Runs `node --disable-warning=ExperimentalWarning --import tsx scripts/judge.ts`.

Stdout on the committed cases starts with:

```text
Judge eval
cases: 17
judge pass rate: 12/17 (70.6%)
baseline: 70.6%
```

The command replays the eval cases first, then prints one block per case. The block is the case id, `pass` or `fail`, and four lines for `plan`, `files`, `tests`, and `review`. Each rule line is the verdict and the reason. Exit 0 means the pass rate is at least `evals/judge-baseline.json`. The committed report is `docs/demo/judge-report.txt`.

`THIN_PR_JUDGE=live` with `THIN_PR_MODEL=live` and `ANTHROPIC_API_KEY` calls `claude-haiku-5-5`. CI leaves both mode variables unset, which selects the rubric. `docs/demo/judge-live.txt` records one live run over the earlier 12 cases. Its spend line is `live spend: 0.002965 USD`.

### pnpm trace

Runs `node --disable-warning=ExperimentalWarning --import tsx scripts/trace.ts`.

The command replays run `run-7` on a scratch checkout and exports OTLP JSON. Set `THIN_PR_TRACE_PATH` to write a file. With the variable empty, the JSON goes to stdout. `docs/demo/trace.json` is one file from this command. `@opentelemetry/sdk-node` 0.300.0 requires Node.js 22.15 or later.

## Layout

`packages/core` is the control plane. It runs the template, appends each step event to SQLite, and does not call a model. `packages/specialists` holds planner, implementer, reviewer, and pr-writer as step handlers, the `Workspace` interface, and `createAnthropicClient`. `THIN_PR_MODEL` is `live`, `record`, or `replay`. `replay` is the default, except in the labeled-issue Action, which defaults to `live` and fails the run when `ANTHROPIC_API_KEY` is missing. `record` and `replay` read the cassette path from `THIN_PR_CASSETTE`. `packages/workspace` is the git checkout a run edits: file tools, the check runner with a scrubbed environment and a timeout, `git diff` against the base, commit and push, and `.thin-pr.yml`. `packages/gate` evaluates plan, contracts, diff, budget, paths, secrets, typecheck, tests, and review. Each rule returns `PASS` or `FAIL` and a reason. `packages/github` is the only package that calls GitHub. It runs `verify`, posts the checks, and pushes `thin-pr/<issue>` and opens or updates a draft pull request when every gate rule passes. A failure comments the run report and pushes nothing. Specialists do not import it.

The YAML templates under `templates/` are data. A step names its id, optional model and effort, retry limit, and optional loop. The labeled-issue entry loads the template whose `label` matches the issue label.

`evals/` holds the sample package and one directory per case under `evals/cases`. `pnpm eval` replays each case's `cassette.jsonl`. `fixtures/gate-pass.jsonl` and `fixtures/gate-fail.jsonl` are the cassettes for the draft path and the failed-rule path.

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
