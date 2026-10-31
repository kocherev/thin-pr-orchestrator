# Working notes

Thin PR Orchestrator. Read this before changing the repo.

## Layout

`packages/core` is the control plane. It runs a typed state machine, appends each transition to SQLite, and does not call a model. `packages/specialists` holds stub workers for now. `packages/gate` exposes a fixed `decide()` stub. `packages/github` will talk to GitHub. `templates/stub-run.json` is the template the machine loads. `evals/` is still for later fixtures.

## Skills

Use ponytail and the working style on every change. Ponytail stops extra code. The working style says how to prove the code that remains.

- `.agents/skills/ponytail` for the smallest complete diff.
- `.agents/skills/working-style` for data shape, tests, and role budgets.
- `.agents/skills/core-boundary` for any edit under `packages/core` or to lint.
- `.agents/skills/make-interfaces-feel-better` and `.agents/skills/interface-catalog` when a change has UI.
- `.agents/skills/design-engineering` and `.agents/skills/design-catalog` when a change has motion or component feel.

## Commands

`pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Hard rule

No model-client import in `packages/core`. ESLint and `scripts/check-core-boundary.ts` both fail the build on one. See `.agents/skills/core-boundary`.
