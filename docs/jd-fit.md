# JD fit

This file maps the repository layout to a few harness and field-engineering themes. It records what the skeleton is for.

## Meta harness

`packages/core` is a thin typed control plane. It runs a template and records each transition. It does not call a model. Workers sit behind `packages/specialists`.

## Anthropic and OpenAI, forward deployed

Specialist input and output are validated with Zod at the boundary. `packages/gate` is where a draft becomes reviewable. `decide()` is a fixed stub. The import ban in `packages/core` is the line model clients must stay behind.

## GitHub Actions

`.github/workflows/ci.yml` runs lint, typecheck, and Vitest. `packages/github` is the reserved entry for a later Action and API client.

## Tesla, forward deployed

`templates/bugfix.yaml`, `templates/small-feature.yaml`, and `templates/docs-update.yaml` load through the same check as `templates/stub-run.json`. `evals/` is reserved for later replay fixtures. The run log itself is SQLite, checked by the replay test in `packages/core`.
