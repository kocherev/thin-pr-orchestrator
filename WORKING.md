# Working notes

Thin PR Orchestrator. Read this before changing the repo.

## Layout

`packages/core` is the control plane. It runs a typed state machine, appends each transition to SQLite, and does not call a model. `packages/specialists` holds stub workers for now. `packages/gate` exposes a fixed `decide()` stub. `packages/github` is the only package that calls GitHub. It creates the branch and the checks for an issue labeled `thin-pr`. Specialists do not import it. `templates/stub-run.json` and the YAML workflows under `templates/` are loaded by the machine. A step names its specialist, fields, retry limit, and optional gate hook. `evals/` is still for later fixtures.

## Skills

Use ponytail and the working style on every change. Ponytail stops extra code. The working style says how to prove the code that remains.

- `skills/ponytail` for the smallest complete diff.
- `skills/working-style` for data shape, tests, and role budgets.
- `skills/core-boundary` for any edit under `packages/core` or to lint.
- `skills/make-interfaces-feel-better` and `skills/interface-catalog` when a change has UI.
- `skills/design-engineering` and `skills/design-catalog` when a change has motion or component feel.

## Commands

`pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Hard rule

No model-client import in `packages/core`. ESLint and `scripts/check-core-boundary.ts` both fail the build on one. See `skills/core-boundary`.
