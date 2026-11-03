# Console

A static Next.js export that shows runs, gate verdicts, diffs and eval results. The build reads JSON from the repo and writes plain HTML to `out/`. There is no server and no API call at runtime.

```bash
pnpm console:build             # from the repo root, writes apps/console/out
pnpm --filter console dev      # local dev server
pnpm --filter console deploy   # wrangler deploy, needs wrangler login
```

The build first runs `tsc -b` on `packages/github`. The console imports the `RunRecord` type from the emitted declarations in `packages/*/dist`.

`wrangler.jsonc` deploys `out/` as an assets-only Worker named `thin-pr-console`. Unknown paths get `404.html`.

## Data

| Source | Contents |
| --- | --- |
| `evals/runs/*.json` | One RunRecord per eval case, written by `pnpm eval -- --write` |
| `evals/report.json` | The eval report, written by the same command |
| `apps/console/data/runs/*.json` | RunRecords from real GitHub runs. Empty for now. |

The build parses every file with the Zod schemas in `lib/schema.ts`. A file that does not match fails the build with the file path and the field. Run ids must be unique across both run folders. A missing folder or report renders an empty state.

`runRecordSchema` parses the RunRecord v1 export from `packages/github/src/record.ts`. The loader returns the imported `RunRecord` type, so a field that drifts between the two fails the console typecheck.

`evalReportSchema` parses the `ReportFile` that `scripts/eval.ts` writes, and `expectedSchema` parses each case label. The Evals page computes the same scores `pnpm eval` prints:

- Verdict accuracy uses the rule in `scripts/eval.ts`. A case is correct when the run opened or blocked as `expected` says, with a failed run counting as blocked, and when it failed exactly the rules listed in `evals/cases/<id>/expected.json`, if any.
- Resolve rate is the share of cases expected to open that opened.
- Cost per resolved case is the spend on cases expected to open, divided by the ones that opened.

Eval runs replay recorded model responses against `example/sample-repo` and `example/sample-python`. The console labels them as replays and shows their issue and pull request numbers without links.

## Tests

`lib/load.test.ts` parses every committed eval run and the report. `lib/diff.test.ts` covers the patch parser. Both run with the root `pnpm test`.
