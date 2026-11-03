# Security

A run reads text from a public issue tracker, asks a model to edit code, and runs that code. This page lists what each part may reach and what stops it.

## Untrusted issue text

The issue title and body come from anyone who can open an issue. Only a label starts a run, and on GitHub only a user with triage access or more can add one.

- Each model request puts the issue in its own content block inside `<issue>` tags. Every system prompt in `packages/specialists/src/prompts.ts` says that block is untrusted data and that an instruction inside it is not an instruction to the model.
- The planner prompt says never to plan changes to CI workflows, lockfiles, or credentials. The `paths` and `secrets` gate rules enforce it. With the default `.thin-pr.yml`, a run that ignores the prompt still cannot open a draft that changes `.github/**`, `pnpm-lock.yaml`, `package-lock.json`, or an `.env` file, or that adds a credential-shaped line.
- The draft body and the run report quote the plan summary and steps, the review summary and notes, and step summaries as the models wrote them.

## Tool confinement

The implementer edits code only through six tools over the `Workspace` interface. There is no shell tool.

- Every path goes through `repoPath` in `packages/workspace/src/paths.ts`. An empty path, an absolute path, a path that climbs out with `..`, and a path into `.git` throw.
- `list_files` and `search` see the files `git ls-files` lists. `search` returns at most 50 matches.
- `read_file` reads any file inside the checkout outside `.git`.
- `replace` edits an existing file, and its old text must match exactly once. It does not check `paths`. The `paths` rule fails the run when the edited file is denied. `docs/gate.md` shows the eval case.
- `create_file` refuses a path that `paths.deny` matches or that no `paths.allow` glob matches, and refuses a file that exists.
- `run_check` takes only `typecheck` or `test` and runs the command `.thin-pr.yml` sets for it. The model cannot pass a command.
- The tool loop fails after 25 turns.

## Check environment

`verify`, `run_check`, and `install` run repository code, including the code the implementer wrote. `runShell` in `packages/workspace/src/check.ts` runs each command through `/bin/sh` in its own process group.

- The environment drops every variable whose name contains `TOKEN`, `KEY`, `SECRET`, or `PASSWORD`, in any case, and every variable that starts with `GITHUB_` or `ANTHROPIC_`. `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` never reach a check.
- A command that runs past the timeout, 5 minutes by default, is killed with its whole process group. Its exit code is 124.
- The result keeps the last 4 KB of output.

## Push token

The token reaches git only for the push, and never through argv or `.git/config`.

- The Action checks out with `persist-credentials: false`, so the checkout stores no token while the checks run.
- `commitAndPush` in `packages/workspace/src/git.ts` passes the token as an `http.https://github.com/.extraheader` entry through `GIT_CONFIG_COUNT` in the push's environment.
- The push uses `--force-with-lease` against the remote-tracking ref, so a branch that moved after the fetch is not overwritten.
- The run pushes only after every gate rule passes, and only to `thin-pr/<issue>`. It never pushes the default branch.

## GitHub App tokens

`packages/app` holds the App's private key as a Worker secret and never sends it to the container.

- The Worker checks `X-Hub-Signature-256` with HMAC-SHA256 over the raw body and a constant-time compare. A bad signature gets 401.
- The Worker queues only an `issues` event whose action is `labeled` and whose label is `thin-pr` or `thin-pr:<name>`. Owner and repository names must match `^[A-Za-z0-9_.-]+$`.
- For each job the queue consumer signs an RS256 JWT with Web Crypto. Its `iat` is 60 seconds in the past and its `exp` is 9 minutes ahead. The consumer trades it for an installation token limited to the one repository. GitHub expires that token after an hour.
- The container gets the installation token as `GITHUB_TOKEN`. The clone and the push send it as the same environment header the Action uses.
- The App manifest asks for write access to checks, contents, issues, and pull requests, and read access to actions and metadata.

## Egress allowlist

The App's container has `enableInternet` off, and `interceptHttps` on so the proxy sees each hostname. It reaches only these hosts:

- `github.com`
- `api.github.com`
- `api.anthropic.com`
- `registry.npmjs.org`
- the host of `OTEL_EXPORTER_OTLP_ENDPOINT`, when that variable is set

The endpoint must use port 443 or 80. Any other port makes the `Runner` throw when it is created. `packages/app/src/runner-config.ts` builds the list. The Action has no allowlist. It runs on a GitHub-hosted runner with that runner's network.

## Secret scan

Two scans look for credentials.

- The `secrets` gate rule scans the lines a run adds before anything is pushed. `docs/gate.md` lists the patterns. A finding names the file, the line, and the kind, and never the value.
- The `secrets` job in `.github/workflows/ci.yml` runs gitleaks on this repository. On a pull request or a push, gitleaks scans the new commits. A manual run scans the full history.

## Workflow permissions

The three workflows set `permissions: {}` at the top and grant each job only what it needs. Every job sets `timeout-minutes`.

- `ci.yml`: the `check` job reads contents. The `secrets` job reads contents and pull requests. `ci.yml` never sets `ANTHROPIC_API_KEY`, and a test in `packages/github/src/run.test.ts` fails if it does.
- `thin-pr.yml`: the labeled-issue job writes contents, checks, issues, and pull requests.
- `nightly-eval.yml`: the job reads contents and pushes nothing. It is the only workflow besides `thin-pr.yml` that gets `ANTHROPIC_API_KEY`.

## Spend cap

`createAnthropicClient` meters every live and recorded call. Before each request, the meter prices the largest reply the request allows and stops with `SpendLimitError` when the session's spend plus that price would pass `THIN_PR_SPEND_LIMIT_USD`. The default is 25 USD. The App sets 25 in `wrangler.jsonc`, and the nightly eval sets 15. Replay never reaches the network.

## Telemetry

The SDK's spans run with `contentMode: "metadata_only"`, set in code. No span carries a prompt, the issue text, a model reply, a tool argument, a diff, a check log, or file contents. `docs/telemetry.md` lists what the spans do carry.

## Limits

- A check runs model-written code with the runner's network access. On the App that network is the allowlist above. On the Action it is open.
- The scrub drops variables by name. A credential in a variable whose name matches none of the rules reaches the checks. `OTEL_EXPORTER_OTLP_HEADERS` is one such variable, and both the Action and the App set it when a trace backend is configured.
- `read_file` can read any file in the checkout. A secret committed to the target repository is visible to the implementer.
