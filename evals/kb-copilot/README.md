# Real-repo eval: kb-copilot

Two stages on one real repo. In stage 1, thin-pr ran ten issues locally, and the owner graded each diff. In stage 2, the thin-pr Action ran on the live repo: real issues, draft PRs, owner review, and merges.

thin-pr ran ten issues against [kb-copilot](https://github.com/kocherev/kb-copilot) at commit `315c64a`, a codebase it had never seen. It's a pnpm and uv monorepo with a Next.js web app, a FastAPI service, an MCP server, a desktop agent, and evals. Six issues are Python and four are TypeScript.

The repo owner wrote each issue, plus a hidden acceptance test that fails before a correct fix and passes after. thin-pr saw only the issue's title and body. It never saw the hidden test or the owner's reference fix. The owner then read every diff and gave a verdict.

Commit `315c64a` was `4d4740f` when the eval ran. kb-copilot later rewrote its history to change the root commit's author, and every commit got a new ID with the same tree, so the diffs and tests apply unchanged.

## Stage 1: ten issues, local runs

| # | Issue | Template | Gate | Files, lines | Cost | Model calls | Hidden test | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | Send the internal token from the MCP get_product tool | bugfix | blocked: `secrets` | 5, 52 | $0.224 | 15 | pass | correct |
| 02 | Limit how many handoffs the agent can propose per session | feature | pass | 4, 83 | $0.713 | 24 | pass | correct |
| 03 | Let approve retry an escalation stuck in creating | bugfix | pass | 2, 87 | $0.392 | 21 | pass | correct |
| 04 | Reject a non-positive --limit in the eval answers script | bugfix | pass | 2, 25 | $0.119 | 15 | pass | correct |
| 05 | Refuse a desktop.scroll that moves nothing | bugfix | pass | 4, 30 | $0.191 | 18 | pass | correct |
| 06 | Remove the unused KB_VOICE setting from the env example and the agent skill | docs | pass | 2, 3 | $0.027 | 7 | pass | correct |
| 07 | Redirect to the public web address, not the address the server sees | bugfix | pass | 5, 57 | $0.179 | 17 | pass | correct |
| 08 | Check the upload limits in the browser before sending files | feature | pass | 2, 85 | $0.183 | 14 | pass | correct |
| 09 | Return to the page the user asked for after signing in | feature | pass | 6, 107 | $0.205 | 18 | fail | correct |
| 10 | Add a Delete product button to the product page | feature | pass | 2, 123 | $0.252 | 18 | pass | correct |

- **The owner judged all 10 fixes correct**, and would merge every one as is.
- **9 of 10 pass the hidden test.**
  - 09 fails it because the test pinned an implementation detail. It expected the form component to read the address bar, while thin-pr's fix has the server page read the query and pass it as a prop.
  - The owner called the fix "arguably better" and is rewriting that test to check behavior.
- **9 of 10 passed the gate.**
  - The gate blocked 01, a correct fix, on two test placeholders: `TOKEN = "internal-secret"` and `WRONG_TOKEN = "wrong-secret"`.
  - [#40](https://github.com/kocherev/thin-pr-orchestrator/pull/40) fixed that rule, and with it 01's diff has no finding.
- **Each issue's narrow check passed on every fix.** These are the owner's existing tests, lint, format and type checks for that part of the repo.
- **Cost and time:** $2.49 for all ten, $0.20 median per issue. Each run took 18 to 160 seconds end to end, including its install.
- **Size:** every change fit its template's budget. The largest was 6 files and 123 lines.

Each folder holds the issue as thin-pr got it (`issue.md`) and the diff it produced (`change.diff`). `results.json` has the numbers.

### What stage 1 changed in thin-pr

- **The planner must answer on its last turn** ([#39](https://github.com/kocherev/thin-pr-orchestrator/pull/39)).
  - The first run failed before writing anything. The planner was still reading at its 8-turn cap, and the retry hit the same wall.
  - Now the last request turns tools off, and the planner plans from what it has read.
  - 9 of the 10 runs used all 8 turns, so without this change 9 would have failed.
- **Word-only placeholders are not credentials** ([#40](https://github.com/kocherev/thin-pr-orchestrator/pull/40)).
- **Config from outside the checkout** ([#38](https://github.com/kocherev/thin-pr-orchestrator/pull/38)). `thin-pr run --config` and `--label` meant nothing had to land in kb-copilot to try it.

## Stage 2: the Action on the live repo

kb-copilot installed the Action (kocherev/kb-copilot#29) and labelled six real issues. thin-pr opened a draft for each. The owner reviewed every draft on GitHub and merged all six.

| Issue | Draft | Template | Size | Spend | Time | Human edits |
| --- | --- | --- | --- | --- | --- | --- |
| [#30](https://github.com/kocherev/kb-copilot/issues/30) Send the internal token from the MCP get_product tool | [#35](https://github.com/kocherev/kb-copilot/pull/35) | bugfix | 5 files, +62 −16 | $0.32 | 4.5 min | none |
| [#31](https://github.com/kocherev/kb-copilot/issues/31) Limit how many handoffs the agent can propose per session | [#50](https://github.com/kocherev/kb-copilot/pull/50) | feature | 4 files, +77 −3 | $0.44 | 4.5 min | none |
| [#32](https://github.com/kocherev/kb-copilot/issues/32) Let approve retry an escalation stuck in creating | [#39](https://github.com/kocherev/kb-copilot/pull/39) | bugfix | 5 files, +103 −12 | $0.50 | 7.5 min | 1 commit: regenerated the OpenAPI client |
| [#33](https://github.com/kocherev/kb-copilot/issues/33) Refuse a desktop.scroll that moves nothing | [#45](https://github.com/kocherev/kb-copilot/pull/45) | bugfix | 3 files, +26 −4 | $0.24 | 5.6 min | none |
| [#34](https://github.com/kocherev/kb-copilot/issues/34) Remove the unused KB_VOICE setting | [#38](https://github.com/kocherev/kb-copilot/pull/38) | docs | 3 files, +1 −3 | $0.03 | 4.4 min | none |
| [#44](https://github.com/kocherev/kb-copilot/issues/44) Reject a non-positive --limit in the eval answers script | [#46](https://github.com/kocherev/kb-copilot/pull/46) | bugfix | 2 files, +26 −1 | $0.15 | 5.2 min | none |

- **6 of 6 merged by the owner.** 5 needed no human edit. #39 needed one commit to regenerate the OpenAPI client, and thin-pr now runs that generator itself.
- **The hidden tests pass on every draft** the owner ran them on: #35, #45, #46 and #50.
- **$1.69 for the six runs that opened the drafts,** about 4 to 8 minutes each, including installs and checks.
- **$2.78 for three runs that failed on the way,** each of which led to a fix:

  | Issue | Spend | What went wrong | Fix |
  | --- | --- | --- | --- |
  | #31, first run | $1.05 | Couldn't regenerate the OpenAPI client. The reviewer correctly asked for changes. | `generate:` |
  | #31, second run | $1.49 | The repo's drift check used `git diff`, and the run looped on its identical failure. | The owner's check now uses `cmp`, and a repeated failure stops the loop. |
  | #33, first run | $0.23 | GitHub answered 404 on a check run created a moment before, and the run crashed after its push. | Checks are posted finished in one call. |

### What stage 2 changed in thin-pr

- **A reusable Action** ([#42](https://github.com/kocherev/thin-pr-orchestrator/pull/42)), pinned by commit ([#44](https://github.com/kocherev/thin-pr-orchestrator/pull/44)).
- **Checks sandboxed as a second user,** so model-written code can't read the keys ([#37](https://github.com/kocherev/thin-pr-orchestrator/pull/37)). Also git working inside them ([#48](https://github.com/kocherev/thin-pr-orchestrator/pull/48)).
- **The repo's CI** started on the draft ([#45](https://github.com/kocherev/thin-pr-orchestrator/pull/45)), with its result shown as `thin-pr / ci` ([#54](https://github.com/kocherev/thin-pr-orchestrator/pull/54)).
- **No crash after a push** when GitHub hasn't caught up with the new commit ([#46](https://github.com/kocherev/thin-pr-orchestrator/pull/46)).
- **Allowlisted generators,** such as `pnpm openapi` ([#47](https://github.com/kocherev/thin-pr-orchestrator/pull/47)).
- **No red checks on the repo's main branch,** and a blocked gate that no longer fails the job ([#50](https://github.com/kocherev/thin-pr-orchestrator/pull/50)).
- **A loop stops** when a step repeats its failure ([#53](https://github.com/kocherev/thin-pr-orchestrator/pull/53)).

## Owner feedback still open

- **Planning cost.** Planning is 20 to 50 percent of each run's cost, and it reads until the cap even for a two-line fix. The planner prompt should state the read budget and say to stop once the files are found.
- The owner noted that most diffs updated the README, decision records and skill docs without being asked, which matches the repo's own habits.

## How stage 1 ran

Each issue ran in a fresh clone of kb-copilot at `315c64a`, with no remote. Nothing was pushed, and no pull request was opened on kb-copilot.

```bash
pnpm thin-pr run --repo <clone> --issue issue.md --config thin-pr.yml --label thin-pr:bugfix
```

The config, kept outside the clone, set:

- the install: `pnpm install --frozen-lockfile` and `uv sync --frozen --all-packages --group dev`
- the issue's narrow check, split into `typecheck` (ruff, pyright or eslint, tsc) and `test` (pytest or vitest)
- path rules that deny `.github/**`, real `.env` files and the lockfiles

After the run, the hidden test was written into the result and run. Live tests, real embeddings and the database stayed off, as the owner asked.
