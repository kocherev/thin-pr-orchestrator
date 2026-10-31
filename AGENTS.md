# Working notes

Thin PR Orchestrator. Read this before changing the repo.

## Layout

`packages/core` is the control plane. It is typed TypeScript and it does not call a model. `packages/specialists` is where model-backed workers will live. `packages/gate` will decide whether a draft is reviewable. `packages/github` will talk to GitHub. `templates/` and `evals/` are data directories for later workflows and replay fixtures.

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

No model-client import in `packages/core`. The scanner is `scripts/check-core-boundary.ts`. An ESLint rule is still a TODO. See `.agents/skills/core-boundary`.
