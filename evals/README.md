# Evals

Offline replay over the sample repo. No live model call.

`evals/sample-repo` is the tree before the change. `evals/issues` holds labeled issue payloads. `evals/responses` holds the recorded specialist output for each issue. `evals/diffs` holds the proposed file contents. `evals/baseline.json` is the minimum gate pass rate. `evals/budget.json` is the file and line budget.

```bash
pnpm eval
```

The command replays each issue through the small-feature workflow and the gate. It prints the gate pass rate and the diff-budget stats. The process exits non-zero when the pass rate is below the committed baseline.
