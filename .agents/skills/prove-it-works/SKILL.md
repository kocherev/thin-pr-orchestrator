---
name: prove-it-works
description: >
  After a change, run the checks and read their output before calling the
  work done. Use when finishing a change in this repo. The checks are
  pnpm lint, pnpm typecheck, pnpm test, pnpm eval, pnpm eval:judge, and
  pnpm trace.
---

# Prove it works

A compile is not the result. Run the command and read what it prints. A file timestamp, a self-report, or a command you did not run is not a pass.

## Checks

From the repo root, after `pnpm install`. Node.js 22.13 or later and pnpm 10.33.4. The install and the meaning of each command are in `AGENTS.md`.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm eval
pnpm eval:judge
pnpm trace
```

Each command exits 0 on success. `pnpm eval` prints the gate pass rate. That rate has to meet `evals/baseline.json`. `pnpm eval:judge` prints the judge's agreement with the human labels. That agreement has to meet `evals/judge-baseline.json`. `pnpm trace` writes OTLP JSON. Set `THIN_PR_TRACE_PATH` when you want the file.

## What to read

- Lint: ESLint, then `scripts/check-core-boundary.ts`. A model-client import under `packages/core` fails here.
- Typecheck: `tsc -b`. The same pass as `pnpm build`.
- Test: Vitest. The label path is `packages/github/src/run.test.ts`. The SQLite replay is `packages/core/src/run.test.ts`. The committed eval numbers are asserted in `scripts/eval.test.ts`.
- Eval: the printed report. Compare the verdict accuracy with `evals/baseline.json`, and read the rules each blocked case failed. Do not lower the baseline to turn a failure into a pass.
- Judge: the printed report. Compare the agreement with `evals/judge-baseline.json`. Replay is the CI path. `pnpm eval:judge -- --record` needs `ANTHROPIC_API_KEY`.
- Trace: span names in the OTLP JSON. The sample file is `docs/demo/trace.json`.

If a check fails, the failure text is the thing to fix. Suspect a wrong command or a wrong working directory before changing a passing package.
