# Evals

Offline replay over the sample repo. No live model call.

`evals/sample-repo` is the tree before the change. `evals/issues` holds labeled issue payloads. `evals/responses` holds the recorded specialist output for each issue. `evals/diffs` holds the proposed file contents. `evals/baseline.json` is the minimum gate pass rate. `evals/budget.json` is the file and line budget.

```bash
pnpm eval
```

The command replays each issue through the small-feature workflow and the gate. It prints the gate pass rate and the diff-budget stats. The process exits non-zero when the pass rate is below the committed baseline. On the committed fixtures that rate is 8/12, printed as 66.7%. The case table is in `README.md`.

`pnpm eval:judge` scores the same cases with the rubric in `packages/specialists/src/judge.ts`. The floor is `evals/judge-baseline.json`, 9/12, printed as 75.0%. The rubric report is `docs/demo/judge-report.txt`. `docs/demo/judge-live.txt` is one live run, spend `0.002965 USD`. CI uses the rubric.
