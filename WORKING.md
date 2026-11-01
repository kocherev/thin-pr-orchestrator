# Working notes

Thin PR Orchestrator. Read this before changing the repo. It is enough to install and run the four checks below. The public overview is `README.md`. The why is `docs/design.md`.

## Requirements

- Node.js 22.13 or later. `.nvmrc` contains `22`.
- pnpm 10.33.4, from the `packageManager` field in `package.json`. Do not switch to another major version.
- A checkout of this repo.

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

Run these from the repo root, in this order, after `pnpm install`. Each one exits 0 when it passes. Read the output. A command you did not run is not a pass.

### pnpm lint

Runs `eslint .`, then `node --experimental-strip-types scripts/check-core-boundary.ts`.

ESLint bans model-client imports and GitHub client imports in `packages/core`. It also bans GitHub client imports in `packages/specialists`, `packages/gate`, and `scripts`. The script scans `packages/core` for `require()` and dynamic `import()` of the same model clients. Either failure exits non-zero. The banned names are listed in `skills/core-boundary`.

### pnpm typecheck

Runs `tsc -b --pretty false`. This is the same compiler pass as `pnpm build`. `pnpm build` also writes `dist/` in each project. Typecheck does not write that output. A type error fails both.

### pnpm test

Runs `vitest run`. The config is `vitest.config.ts`. Workers get `--experimental-sqlite` and `--disable-warning=ExperimentalWarning`. Included files are `packages/*/src/**/*.test.ts` and `scripts/**/*.test.ts`.

Useful single files:

```bash
pnpm exec vitest run packages/core/src/run.test.ts
pnpm exec vitest run packages/github/src/run.test.ts
pnpm exec vitest run packages/specialists/src/schema.test.ts
pnpm exec vitest run scripts/eval.test.ts
```

`packages/core/src/run.test.ts` writes a SQLite log, reopens it, and expects `replay` to match `runWorkflow`. `packages/github/src/run.test.ts` runs `fixtures/sample-issue-labeled.json` through an in-memory GitHub client. `scripts/eval.test.ts` runs the eval and expects the committed 8/12 report. `scripts/judge.test.ts` expects the judge report at 9/12. `scripts/trace.test.ts` expects six span names in the OTLP file.

### pnpm eval

Runs `node --disable-warning=ExperimentalWarning --import tsx scripts/eval.ts`.

Stdout on the committed fixtures:

```text
Replay eval
cases: 12
gate pass rate: 8/12 (66.7%)
baseline: 66.7%
diff budget: 2 files, 16 lines
within budget: 10/12
files changed: min 1, median 1, max 4
lines changed: min 1, median 2.5, max 31
```

The command then prints one line per case: id, `pass` or `fail`, file count, line count, and `within budget` or `over budget`. The full table is in `README.md`. Exit 0 means the gate pass rate is at least `evals/baseline.json`. The budget rule is part of that gate, so an over-budget diff fails the case.

Do not lower `evals/baseline.json`, and do not edit `scripts/eval.test.ts`, to turn a red eval green. If you change a fixture, update the README table in the same change and keep the test honest.

### pnpm eval:judge

Runs `node --disable-warning=ExperimentalWarning --import tsx scripts/judge.ts`.

Stdout on the committed fixtures:

```text
Judge eval
cases: 12
judge pass rate: 9/12 (75.0%)
baseline: 75.0%
```

The command then prints one block per case. The block is the case id, `pass` or `fail`, and four lines for `plan`, `files`, `tests`, and `review`. Each rule line is the verdict and the reason. Exit 0 means the pass rate is at least `evals/judge-baseline.json`. The committed report is `docs/demo/judge-report.txt`.

`THIN_PR_JUDGE=live` with `THIN_PR_MODEL=live` and `ANTHROPIC_API_KEY` calls `claude-haiku-5-5`. CI leaves both mode variables unset, which selects the rubric. `docs/demo/judge-live.txt` records one live run. Its spend line is `live spend: 0.002965 USD`.

### pnpm trace

Runs `node --disable-warning=ExperimentalWarning --import tsx scripts/trace.ts`.

The command replays run `run-7` and exports OTLP JSON. Set `THIN_PR_TRACE_PATH` to write a file. With the variable empty, the JSON goes to stdout. `docs/demo/trace.json` is one file from this command. `@opentelemetry/sdk-node` 0.300.0 requires Node.js 22.15 or later.

## Layout

`packages/core` is the control plane. It runs the template, appends each transition to SQLite, and does not call a model. `packages/specialists` holds planner, implementer, tester, reviewer, and pr-writer. The default model client is `ReplayModelClient`. `THIN_PR_MODEL=live` selects the live client in `packages/specialists/src/live.ts`. `packages/gate` evaluates plan, tests, contracts, the measured diff, and the diff budget. Each rule returns `PASS` or `FAIL` and a reason. The tests rule still reads the tester contract, and it also requires the runner's own file check. `packages/github` is the only package that calls GitHub. It creates the branch, the checks, and a draft pull request when every gate rule passes. A failure comments the run report and does not open a pull request. Specialists do not import it.

`templates/stub-run.json` and the YAML workflows under `templates/` are loaded by the machine. A step names its specialist, fields, retry limit, and optional gate hook. The labeled-issue entry loads `templates/small-feature.yaml` only.

`evals/` holds the sample repo, labeled issues, recorded responses, and recorded diffs. `pnpm eval` replays them. `fixtures/gate-pass.json` and `fixtures/gate-fail.json` are the specialist outputs for the draft path and the failed-rule path.

`ping` in `packages/core` returns `pong`. The workspace test uses it as a smoke check.

## Skills

Use ponytail and the working style on every change. Ponytail stops extra code. The working style says how to prove the code that remains.

- `skills/ponytail` for the smallest complete diff.
- `skills/working-style` for data shape, tests, and role budgets.
- `skills/core-boundary` for any edit under `packages/core` or to lint.
- `skills/prove-it-works` before calling a change done.
- `skills/typescript-best-practices` when editing `.ts` files. Tests and diff size stay with `skills/working-style`.
- `skills/technical-writing` when editing `README.md`, `docs/`, `WORKING.md`, or pull request text.
- `skills/unslop` when editing that same public copy.
- `skills/make-interfaces-feel-better` and `skills/interface-catalog` when a change has UI.
- `skills/design-engineering` and `skills/design-catalog` when a change has motion or component feel.

## Hard rule

No model-client import in `packages/core`. ESLint and `scripts/check-core-boundary.ts` both fail the build on one. See `skills/core-boundary`. GitHub clients belong in `packages/github`.
