# Thin PR Orchestrator

A GitHub issue goes in. A thin control plane runs a fixed workflow and calls specialized workers through a typed boundary. A person reviews the result.

The control plane is ordinary TypeScript. It does not call a model. Model clients are injected into `packages/specialists`. This tree uses a replay client that returns fixture JSON. Labeling an issue `thin-pr` creates a branch and posts a check per step. Gate rules then post their own checks. A draft pull request opens only when every gate rule passes.

## Requirements

- Node.js 22 (see `.nvmrc`)
- pnpm 10.33.4, from the `packageManager` field in `package.json`
- TypeScript 6.0.3, installed by `pnpm install`

Enable Corepack if `pnpm` is not already on your path. Corepack ships with Node 22.

```bash
corepack enable
corepack prepare pnpm@10.33.4 --activate
```

## Setup

```bash
git clone https://github.com/kocherev/thin-pr-orchestrator.git
cd thin-pr-orchestrator
pnpm install
cp .env.example .env
```

`.env` is gitignored. `.env.example` contains placeholders only.

## Scripts

- `pnpm lint` runs ESLint, then `scripts/check-core-boundary.ts`.
- `pnpm typecheck` runs `tsc -b`.
- `pnpm test` runs Vitest.
- `pnpm build` runs `tsc -b` and writes `dist/` in each project.

`typecheck` and `build` use the same compiler pass. A type error fails both.

## Packages

- `packages/core` is the control plane. Typed code only. No model client imports. `runWorkflow` follows a template and appends every transition to SQLite. `replay` folds that log back into a run state. `ping` still returns `"pong"`.
- `packages/specialists` defines planner, implementer, tester, reviewer, and pr-writer. Each one checks its input and output with Zod. A replay model client returns fixture JSON. Invalid output fails the step.
- `packages/gate` evaluates plan, tests, and specialist contracts. `evaluate()` returns `PASS` or `FAIL` and a reason for each rule. `decide(subject)` returns `"pass"` only when every rule passes. `readiness()` returns `"ready"`.
- `packages/github` is the only package that calls GitHub. An issue labeled `thin-pr` creates branch `thin-pr/<issue number>` and posts one check per step. Each gate rule posts a check named `thin-pr / gate / <rule>`. When every rule passes, the run opens a draft pull request. The body contains the plan, the test results, and the run report. A failed step or a failed rule comments the run report on the issue and does not open a pull request. Specialists do not import this package.

`loadTemplate` reads `templates/stub-run.json` and the YAML workflows `bugfix`, `small-feature`, and `docs-update`. Zod checks each file when it loads. A bad template throws with the file line.

`evals/` will hold replay fixtures. Nothing reads that directory yet.

## Run and replay

`pnpm test` runs the replay test. Node 22 needs `--experimental-sqlite` for `node:sqlite`. `vitest.config.ts` passes that flag to the test workers.

To run the replay file on its own:

```bash
pnpm exec vitest run packages/core/src/run.test.ts
```

The test writes a SQLite log, closes it, opens it again, and expects `replay` to return the same final state as `runWorkflow`. A second run with the same inputs produces that same state.

To run the invalid-output failure test on its own:

```bash
pnpm exec vitest run packages/specialists/src/schema.test.ts
```

That file feeds a reviewer payload whose `notes` entry is a number, then asserts the error path `notes.0`. `packages/core/src/run.test.ts` covers the same failure on the plan step and checks that the log stops after the step is entered.

## Issue label

`.github/workflows/thin-pr.yml` runs when an issue receives the label `thin-pr`. GitHub reads that workflow from the default branch, so the file has to be on the default branch before a label starts a run.

The run creates `thin-pr/<issue number>` from the default branch tip, then adds one commit that keeps the same tree. That commit is the head for the checks and the draft pull request. The file diff stays empty until a later change writes files.

Each template step posts a Checks API check named `thin-pr / <step>`. Each gate rule posts `thin-pr / gate / <rule>`. The rule check title is `PASS` or `FAIL`, and the summary is that verdict plus the reason. The rules are plan, tests, and contracts.

When every rule passes, the run opens a draft pull request into the default branch. The body has `## Plan`, `## Test results`, and `## Run report`. A failed step or a failed rule is marked failure, the issue gets a comment that starts with `## Run report`, and no pull request is opened.

`fixtures/sample-issue-labeled.json` is a sample `issues.labeled` payload for `example/sample-repo`. `fixtures/gate-pass.json` and `fixtures/gate-fail.json` are the specialist outputs for the draft path and the failed-rule path. The test runs the sample payload through the action entry with an in-memory GitHub client.

```bash
pnpm exec vitest run packages/github/src/run.test.ts
```

After the workflow is on the default branch of a repository:

1. Create the label `thin-pr`.
2. Open an issue.
3. Add the label `thin-pr`.
4. The Actions run creates the branch, the checks, and, when every gate rule passes, a draft pull request. Adding the label again tries to create the same branch. If that ref already exists, the run fails and the issue gets another report.

## CI

`.github/workflows/ci.yml` runs lint, typecheck, and test on pull requests and on pushes to `main`.

## Working notes

See `WORKING.md` and `skills/` for the rules that apply when changing this repo. The hard rule for `packages/core` is also documented in `skills/core-boundary`.

## License

MIT. See `LICENSE`.
