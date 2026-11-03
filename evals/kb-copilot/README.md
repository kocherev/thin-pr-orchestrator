# Real-repo eval: kb-copilot

thin-pr ran ten issues against [kb-copilot](https://github.com/kocherev/kb-copilot) at commit `4d4740f`, a codebase it had never seen. It's a pnpm and uv monorepo with a Next.js web app, a FastAPI service, an MCP server, a desktop agent, and evals. Six issues are Python and four are TypeScript.

The repo owner wrote each issue, plus a hidden acceptance test that fails before a correct fix and passes after. thin-pr saw only the issue's title and body. It never saw the hidden test or the owner's reference fix. The owner then read every diff and gave a verdict.

## Results

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

## What the eval changed in thin-pr

- **The planner must answer on its last turn** ([#39](https://github.com/kocherev/thin-pr-orchestrator/pull/39)).
  - The first run failed before writing anything. The planner was still reading at its 8-turn cap, and the retry hit the same wall.
  - Now the last request turns tools off, and the planner plans from what it has read.
  - 9 of the 10 runs used all 8 turns, so without this change 9 would have failed.
- **Word-only placeholders are not credentials** ([#40](https://github.com/kocherev/thin-pr-orchestrator/pull/40)).
- **Config from outside the checkout** ([#38](https://github.com/kocherev/thin-pr-orchestrator/pull/38)). `thin-pr run --config` and `--label` meant nothing had to land in kb-copilot to try it.

## Owner feedback still open

- **Planning cost.** Planning is 20 to 50 percent of each run's cost, and it reads until the cap even for a two-line fix. The planner prompt should state the read budget and say to stop once the files are found.
- **Generators.** For 02, thin-pr edited the generated `openapi.json` and `schema.d.ts` by hand. They matched `pnpm openapi` exactly, but an allowlisted generator command would be safer and cheaper. 02 was the cost outlier at $0.71.
- The owner noted that most diffs updated the README, decision records and skill docs without being asked, which matches the repo's own habits.

## How it ran

Each issue ran in a fresh clone of kb-copilot at `4d4740f`, with no remote. Nothing was pushed, and no pull request was opened on kb-copilot.

```bash
pnpm thin-pr run --repo <clone> --issue issue.md --config thin-pr.yml --label thin-pr:bugfix
```

The config, kept outside the clone, set:

- the install: `pnpm install --frozen-lockfile` and `uv sync --frozen --all-packages --group dev`
- the issue's narrow check, split into `typecheck` (ruff, pyright or eslint, tsc) and `test` (pytest or vitest)
- path rules that deny `.github/**`, real `.env` files and the lockfiles

After the run, the hidden test was written into the result and run. Live tests, real embeddings and the database stayed off, as the owner asked.
