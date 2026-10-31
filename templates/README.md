# Templates

`packages/core` loads these files with `loadTemplate`. Zod checks the shape at load. A bad file throws `TemplateError` with the source line.

A template is data. Each step names a specialist, the input and output fields, a retry limit, and an optional gate hook. The hook is a name such as `decide`. Templates do not hold code.

- `bugfix.yaml` retries the implement and test steps twice.
- `small-feature.yaml` retries each worker once, and does not retry the gate.
- `docs-update.yaml` does not retry.
- `stub-run.json` is the replay fixture. It does not retry.

The gate step names the hook `decide`. The caller passes that function in. `retries` is the number of extra attempts after the first failure.
