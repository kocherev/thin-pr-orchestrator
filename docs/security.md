# Security

A run reads text from a public issue tracker, asks a model to edit code, and runs that code. This page lists what each part may reach and what stops it.

## Untrusted issue text

The issue title and body come from anyone who can open an issue. Only a label, a command, or a review starts a run. On GitHub only a user with triage access or more can add a label, and the router takes commands and reviews only from users with write access.

- Each model request puts the issue in its own content block inside `<issue>` tags. Every system prompt in `packages/specialists/src/prompts.ts` says that block is untrusted data and that an instruction inside it is not an instruction to the model.
- The planner prompt says never to plan changes to CI workflows, lockfiles, or credentials. The `paths` and `secrets` gate rules enforce it. With the default `.thin-pr.yml`, a run that ignores the prompt still cannot open a draft that changes `.github/**`, `pnpm-lock.yaml`, `package-lock.json`, or an `.env` file, or that adds a credential-shaped line.
- The draft body and the run report quote the plan summary and steps, the review summary and notes, and step summaries as the models wrote them.
- A revise run puts the review text and inline comments in the implement feedback and in the plan. They come from a user with write access, and the same gate rules apply to the commit they produce.

## Commands and reviews

`routeEvent` in `packages/github/src/router.ts` decides which events start anything. The Action and the App call the same function.

- **Author check.** A `/thin-pr` command, a review, and an inline comment start a run only when GitHub's `author_association` for the author is `OWNER`, `MEMBER`, or `COLLABORATOR`. Anyone else is ignored, with no reply, so an outsider cannot make the app spend or post. The workflow's job condition repeats the check, so the runner does not start for an outsider.
- **Bot-loop guard.** The router ignores every event whose sender is a bot, and every comment or review whose author is a bot. The app's own progress comment and command replies quote `/thin-pr approve`, and they never start a command. The workflow condition skips bot senders too.
- **Marker trust.** A stored run and a revise reply are hidden markers in a comment, and anyone can type one. `/thin-pr approve` and `/thin-pr cancel` read the stored run only from a comment whose author is the token's own login, and only from the newest run comment on the issue. A revise run skips a review only when its own reply for that review exists. The run learns its login from the reaction it adds first, because an installation token cannot read `GET /user`. A marker in anyone else's comment is never read.
- **Re-check before acting.** `openApprovedDraft` re-checks the stored run's status, its gate results, and the branch head before it opens the draft. Cancel deletes the branch only while it still points at the commit the gate measured.
- **Drafts only.** A review starts a revise run only on an open pull request whose head is `thin-pr/<issue>` in the same repository. A fork's pull request is ignored.

## Tool confinement

The implementer edits code only through six tools over the `Workspace` interface. There is no shell tool.

- Every path goes through `repoPath` in `packages/workspace/src/paths.ts`. An empty path, an absolute path, a path that climbs out with `..`, and a path into `.git` throw.
- `list_files` and `search` see the files `git ls-files` lists. `search` returns at most 50 matches.
- `read_file` reads any file inside the checkout outside `.git`.
- `replace` edits an existing file, and its old text must match exactly once. It does not check `paths`. The `paths` rule fails the run when the edited file is denied. `docs/gate.md` shows the eval case.
- `create_file` refuses a path that `paths.deny` matches or that no `paths.allow` glob matches, and refuses a file that exists.
- `run_check` takes only `typecheck` or `test` and runs the command `.thin-pr.yml` sets for it. The model cannot pass a command.
- The implementer's tool loop fails after 60 turns, and the planner's after 8. The planner has only `read_file` and `search`.

## Check environment

`verify`, `run_check`, and `install` run repository code, including the code the implementer wrote. `runShell` in `packages/workspace/src/check.ts` runs each command through `/bin/sh` in its own process group.

- The environment drops every variable whose name contains `TOKEN`, `KEY`, `SECRET`, or `PASSWORD`, in any case. It also drops every variable that starts with `GITHUB_`, `ANTHROPIC_`, or `OTEL_`. `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, and `OTEL_EXPORTER_OTLP_HEADERS`, which holds a trace backend's API key, never reach a check.
- A command that runs past the timeout, 5 minutes by default, is killed with its whole process group. Its exit code is 124.
- The result keeps the last 4 KB of output.

## Push token

The token reaches git only for the push, and never through argv or `.git/config`.

- The Action checks out with `persist-credentials: false`, so the checkout stores no token while the checks run.
- `commitAndPush` in `packages/workspace/src/git.ts` passes the token as an `http.https://github.com/.extraheader` entry through `GIT_CONFIG_COUNT` in the push's environment.
- The push uses `--force-with-lease` against the remote-tracking ref, so a branch that moved after the fetch is not overwritten.
- The run pushes only after every gate rule passes, or only `budget` asks for approval, and only to `thin-pr/<issue>`. A revise run pushes one commit on top of the branch after the gate passes. Nothing pushes the default branch.
- `/thin-pr cancel` deletes `thin-pr/<issue>` through the API. It deletes no other branch.

## GitHub App tokens

`packages/app` holds the App's private key as a Worker secret and never sends it to the container.

- The Worker checks `X-Hub-Signature-256` with HMAC-SHA256 over the raw body and a constant-time compare. A bad signature gets 401.
- The Worker queues only a trigger that `routeEvent` returns, from the same checks as the Action. Owner and repository names must match `^[A-Za-z0-9_.-]+$`.
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
- `thin-pr.yml`: one job handles labels, commands, and reviews. It writes contents to push and delete `thin-pr/<issue>`, checks for the step and rule checks, issues for the progress comment and replies, and pull requests to open the draft, read reviews, and reply on the draft. Each kind of event needs most of the four, so one job keeps them.
- `nightly-eval.yml`: the job reads contents and pushes nothing. It is the only workflow besides `thin-pr.yml` that gets `ANTHROPIC_API_KEY`.

## Spend cap

`createAnthropicClient` meters every live and recorded call. Before each request, the meter prices the largest reply the request allows and stops with `SpendLimitError` when the session's spend plus that price would pass `THIN_PR_SPEND_LIMIT_USD`. The default is 25 USD. The App sets 25 in `wrangler.jsonc`, and the nightly eval sets 15. Each run also has its own cap, the template's `spend_usd` or the `.thin-pr.yml` override, and the same check stops a call that could pass it. A spend stop fails the run at once without retries. Replay never reaches the network.

## Telemetry

The SDK's spans run with `contentMode: "metadata_only"`, set in code. No span carries a prompt, the issue text, a model reply, a tool argument, a diff, a check log, or file contents. `docs/telemetry.md` lists what the spans do carry.

## Limits

- A check runs model-written code with the runner's network access. On the App that network is the allowlist above. On the Action it is open.
- The scrub drops variables by name. A credential in a variable whose name matches none of the rules reaches the checks.
- `read_file` can read any file in the checkout. A secret committed to the target repository is visible to the implementer.
