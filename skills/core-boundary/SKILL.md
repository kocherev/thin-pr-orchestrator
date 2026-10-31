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

`pnpm lint` enforces the ban twice. ESLint `no-restricted-imports` rejects a static import under `packages/core`. `scripts/check-core-boundary.ts` rejects `require()` and dynamic `import()` as well, and it exits non-zero when it finds one. Add a new model SDK to both lists.
