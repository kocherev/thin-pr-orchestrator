# JD fit

This file maps the repository layout to a few harness and field-engineering themes. It records what the skeleton is for.

## Meta harness

`packages/core` is a thin typed control plane. It will sequence work. It does not call a model. Workers sit behind `packages/specialists`.

## Anthropic and OpenAI, forward deployed

Specialist input and output will be validated at the boundary. `packages/gate` is where a draft becomes reviewable. Neither check is implemented in this skeleton. The import ban in `packages/core` is the line those clients must stay behind.

## GitHub Actions

`.github/workflows/ci.yml` runs lint, typecheck, and Vitest. `packages/github` is the reserved entry for a later Action and API client.

## Tesla, forward deployed

`templates/` holds workflow names as data (`bugfix`, `small-feature`, `docs-update`). `evals/` is reserved for replay fixtures, so a later change to the control plane can be checked against recorded runs. Both directories are unloaded.
