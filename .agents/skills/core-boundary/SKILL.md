---
name: core-boundary
description: >
  packages/core is typed control flow with no model client imports.
  Use when editing packages/core, adding a dependency, or touching lint.
---

# Core boundary

`packages/core` imports no model client. Workers that call a model live in `packages/specialists`, later. The control plane passes typed values in and out.

Banned specifiers today, matched on the package name:

- `openai`
- `@anthropic-ai/sdk`
- `@ai-sdk/anthropic`
- `@ai-sdk/openai`
- `@ai-sdk/google`
- `@google/generative-ai`
- `ai`

`pnpm lint` runs `scripts/check-core-boundary.ts`. The script exits non-zero when any of those names is imported under `packages/core`.

TODO: replace that script with an ESLint rule for the same denylist. The empty rules block in `eslint.config.js` for `packages/core/**/*.ts` is the placeholder for that rule.
