# Evals

Offline replay over a real sample package. No live model call. The checks run for real.

`evals/sample-repo` is the tree before the change: a TypeScript package with no runtime dependencies, a `tsconfig.json`, visible vitest tests under `test/`, and a `.thin-pr.yml` whose checks are `tsc --noEmit` and `vitest run`. Each directory under `evals/cases` is one labeled issue:

- `issue.json` is the labeled-issue payload.
- `responses.json` holds the recorded planner, implementer, reviewer, and pr-writer replies.
- `files/` holds the files the implementer returned. The run writes them through the workspace.
- `hidden/*.test.ts` are tests the implementer never sees. They are copied to `test/hidden/` right before verify.
- `expected.json` is the verdict, `opened` or `blocked`, and for a blocked case usually the gate rules that must fail.

`evals/baseline.json` is the minimum verdict accuracy.

```bash
pnpm eval
```

The command copies the sample package into a scratch git repo per case, runs the small-feature workflow and the gate, and compares the result with `expected.json`. `tsc` and `vitest` come from this repo's `node_modules/.bin`, so no case installs anything. The report prints the verdict accuracy, opened good and blocked bad counts, the gate rules some case fails, and one line per case. The process exits non-zero when the accuracy is below the committed baseline. On the committed cases it prints `verdict accuracy: 17/17 (100.0%)`. The case table is in `README.md`.

`pnpm eval:judge` replays the same cases and scores each run with the rubric in `packages/specialists/src/judge.ts`. The floor is `evals/judge-baseline.json`, 12/17, printed as 70.6%. The rubric report is `docs/demo/judge-report.txt`. `docs/demo/judge-live.txt` is one live run over the earlier 12 cases, spend `0.002965 USD`. CI uses the rubric.
