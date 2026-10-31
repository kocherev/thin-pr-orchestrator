---
name: working-style
description: >
  How to change this repo. Smallest complete diff, a named data shape,
  tests of observable behavior, and a separate reasoning budget per role
  when work is split. Use on any code change, together with ponytail.
---

# Working style

Use this with `skills/ponytail`. Ponytail picks the smallest complete change. This file says how to shape that change and how to check it. The two apply together. ponytail-mode is the source of the sequencing and verification rules. pstack is the source of the per-role budget.

## Before code

Name the data. If the change is stateful, put the states in a type or a table before writing branches. `packages/core` is that control plane. It stays free of model clients. See `core-boundary`.

Read the callers, tests, and exports the change touches. That list is the scope.

## Checks

A test asserts something a caller can observe. `ping()` returns `"pong"`. A private helper's call count is not a test.

Run `pnpm test` for the behavior, `pnpm typecheck` for the types, and `pnpm lint` for the import boundary. A compile on its own is not done.

## Sequence

One verifiable slice at a time. The skeleton lands before the state machine. A scaffolding change does not implement specialists, the gate, or the GitHub entry.

## Role budgets

When a change is split across people or helpers, give each role its own reasoning budget.

- Implementation of a specified change uses a standard budget.
- Judgment, prose, and API shape use a higher budget.
- Review of a diff uses a higher budget, and it is a separate pass from the one that wrote the diff.
- Mechanical edits use a lower budget.

Record the split in the pull request when you used one. Do not write a vendor model name into this repository.

## Prose

Short sentences. One thought each. Keep a comment only when the code cannot show the reason. Docs name the command to run and the directory it affects.
