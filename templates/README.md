# Templates

`packages/core` reads these files with `templateForLabel`. Zod checks the shape at load. A bad file throws `TemplateError` with the source line.

A template is data. `label` is the issue label that selects it. `budget` has `max_files` and `max_lines`, the review size a run may reach before the gate asks a person to approve it. Lines count added plus removed. `spend_usd` is the most one run may spend on model calls. `.thin-pr.yml` in the target repo can override `budget.max_files`, `budget.max_lines`, and `spend_usd` one field at a time. `steps` lists `plan`, `implement`, `verify`, `review`, and `write` in order. A model step may set `model` and `effort`. `verify` takes no model. `retries` is the number of extra attempts after a step fails, and each retry gets the error as feedback. `loop` sends the run back to an earlier step with feedback. `max` caps those loops for the whole run, and core enforces the cap.

| File | Label | Budget | Spend | Shape |
| --- | --- | --- | --- | --- |
| `feature.yaml` | `thin-pr` | 12 files, 600 lines | 5 USD | One retry per model step. Verify and review each loop back to implement at most twice. |
| `bugfix.yaml` | `thin-pr:bugfix` | 6 files, 250 lines | 3 USD | Two implement retries. Verify loops back to implement at most three times. |
| `docs.yaml` | `thin-pr:docs` | 8 files, 400 lines | 1 USD | Smaller models. Verify does not loop. Review loops back to implement at most once. |
| `revise.yaml` | `thin-pr:revise` | 6 files, 250 lines | 2 USD | Runs on a review of a thin-pr draft, not on a label. The plan is the review, one step per comment, with no model call. Verify loops back to implement at most twice, review at most once. The budget measures the new commit only. |

The first real-repo eval, ten issues on kb-copilot in `evals/kb-copilot`, changed 2 to 6 files and 3 to 123 lines per issue, and a run cost $0.03 to $0.71. Every change fit its budget. Ten runs are too few to tighten the values, so they stay until more real runs come in.

The gate is not a step. `packages/github` evaluates it after `write`. A diff over the budget that passes every other rule pushes the branch and waits for `/thin-pr approve`. A model call that could pass `spend_usd` is not sent, and the run fails with a report. `docs/gate.md` has the details.
