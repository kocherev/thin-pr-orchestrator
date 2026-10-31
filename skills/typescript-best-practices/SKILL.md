---
name: typescript-best-practices
description: >
  TypeScript rules for this repo. Use when editing a .ts file. Tests, diff
  size, and role budgets stay in skills/working-style.
paths: ["**/*.ts", "**/*.tsx"]
---

# TypeScript

Read `skills/working-style` for the shape of the change and for tests. This file is the type and boundary rules already used in the packages.

## Boundaries

External JSON stays `unknown` until a Zod schema parses it. Specialist inputs and outputs are `.strict()` objects in `packages/specialists/src/specialists.ts`. Parse with `safeParse` or `executeSpecialist`. Use the parsed data after that. Do not declare a parallel interface for the same object.

A bad specialist value throws `SpecialistSchemaError` with the specialist, the phase, and the first issue path. A bad template throws `TemplateError` with the file line. Keep that shape when you add a schema.

## Closed sets

Model a fixed set as a string-literal union backed by a const array, as `SPECIALIST_NAMES` does. Switch on the discriminant. In the default arm, assign the value to `never` so a new variant fails the build.

Do not add an optional field to mean a second state. A missing plan and a present plan are different values at the gate. The gate already treats `null` and `undefined` as missing.

## Casts and any

Do not use `any`. Do not use `as` to skip a parse. The casts in the loader and the eval script sit after a runtime check that the value is a non-null object. A new cast needs that same kind of check, or it needs to go away.

Prefer `satisfies` when you are checking a literal and want to keep its type. Prefer `z.infer` when a name for a schema's type would otherwise be written by hand.

## Packages

`packages/core` imports no model client and no GitHub client. The lists are in `skills/core-boundary` and `eslint.config.js`. A specialist calls `ModelClient.complete` and returns JSON. The GitHub calls stay in `packages/github/src/surface.ts`.

## Tests

Assert a value a caller can observe. `ping()` returns `pong`. A gate result has a rule, a verdict, and a reason. A private helper's call count is not a test. `skills/working-style` is the rest of that rule.
