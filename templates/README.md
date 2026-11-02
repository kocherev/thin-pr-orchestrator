# Templates

`packages/core` reads these files with `templateForLabel`. Zod checks the shape at load. A bad file throws `TemplateError` with the source line.

A template is data. `label` is the issue label that selects it. `steps` lists `plan`, `implement`, `verify`, `review`, and `write` in order. A model step may set `model` and `effort`. `verify` takes no model. `retries` is the number of extra attempts after a step fails, and each retry gets the error as feedback. `loop` sends the run back to an earlier step with feedback. `max` caps those loops for the whole run, and core enforces the cap.

| File | Label | Shape |
| --- | --- | --- |
| `small-feature.yaml` | `thin-pr` | One retry per model step. Verify and review each loop back to implement at most twice. |
| `bugfix.yaml` | `thin-pr:bugfix` | Two implement retries. Verify loops back to implement at most three times. |
| `docs-update.yaml` | `thin-pr:docs` | Smaller models. Verify does not loop. Review loops back to implement at most once. |

The gate is not a step. `packages/github` evaluates it after `write`.
