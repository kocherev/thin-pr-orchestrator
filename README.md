# Thin PR Orchestrator

A GitHub issue goes in. A thin control plane runs a fixed workflow, calls specialized workers through a typed boundary, and opens a draft pull request for a person to review.

The control plane is ordinary TypeScript. It does not call a model. Model clients are injected into `packages/specialists`. This tree uses a replay client that returns fixture JSON. Gate rules and the GitHub entry are not implemented yet.

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
- `packages/gate` exports `decide()`, which returns `"pass"`. Real review rules are not written yet. `readiness()` stays `unconfigured`.
- `packages/github` will hold the Octokit client and the Action entry. It reports `not-wired`.

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

## CI

`.github/workflows/ci.yml` runs lint, typecheck, and test on pull requests and on pushes to `main`.

## Working notes

See `WORKING.md` and `skills/` for the rules that apply when changing this repo. The hard rule for `packages/core` is also documented in `skills/core-boundary`.

## License

MIT. See `LICENSE`.
