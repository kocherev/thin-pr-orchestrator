# Thin PR Orchestrator

A GitHub issue goes in. A thin control plane runs a fixed workflow, calls specialized workers through a typed boundary, and opens a draft pull request for a person to review.

The control plane is ordinary TypeScript. It does not call a model. Model clients belong in `packages/specialists`, and only once that package has a real worker. This repository is the workspace skeleton. The state machine, worker contracts, gate rules, and GitHub entry are not implemented yet.

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

- `packages/core` is the control plane. Typed code only. No model client imports. It exports `ping`, which returns `"pong"`.
- `packages/specialists` will hold worker input and output schemas. It exports an empty registry.
- `packages/gate` will hold the rules that allow a draft to be reviewed. It reports `unconfigured`.
- `packages/github` will hold the Octokit client and the Action entry. It reports `not-wired`.

`templates/` reserves `bugfix`, `small-feature`, and `docs-update`. The YAML files are not loaded.

`evals/` will hold replay fixtures. Nothing reads that directory yet.

## CI

`.github/workflows/ci.yml` runs lint, typecheck, and test on pull requests and on pushes to `main`.

## Working notes

See `AGENTS.md` and `.agents/skills/` for the rules that apply when changing this repo. The hard rule for `packages/core` is also documented in `.agents/skills/core-boundary`.

## License

MIT. See `LICENSE`.
