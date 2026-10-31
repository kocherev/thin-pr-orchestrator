# JD fit

This file maps the repository layout to a few harness and field-engineering themes. It records what the skeleton is for.

## Meta harness

`packages/core` is a thin typed control plane. It runs a template and records each transition. It does not call a model. Workers sit behind `packages/specialists`.

## Anthropic and OpenAI, forward deployed

Specialist input and output are validated with Zod at the boundary. `packages/gate` checks plan presence, test results, and those contracts before a draft can open. The import ban in `packages/core` is the line model clients must stay behind.

## GitHub Actions

`.github/workflows/ci.yml` runs lint, typecheck, and Vitest. `.github/workflows/thin-pr.yml` starts a run when an issue is labeled `thin-pr`. `packages/github` calls Octokit for the branch, the checks, and a draft pull request when every gate rule passes. A failure stays a comment. The other packages do not.

## Tesla, forward deployed

`templates/bugfix.yaml`, `templates/small-feature.yaml`, and `templates/docs-update.yaml` load through the same check as `templates/stub-run.json`. `evals/` is reserved for later replay fixtures. The run log itself is SQLite, checked by the replay test in `packages/core`.
