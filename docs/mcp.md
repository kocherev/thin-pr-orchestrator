# Local runs and the MCP server

Run an issue against a git checkout on your machine, from a shell or from an MCP client. Neither path calls GitHub or pushes.

## Run an issue from the command line

From this repo's root, after `pnpm install`:

```bash
pnpm thin-pr run --repo /path/to/checkout --issue issue.md
```

`--issue` takes a file or the issue text itself. The first line is the title, with any leading `#` dropped. The rest is the body. `--out` sets the directory for the RunRecord.

`runLocal` in `packages/github/src/local.ts` runs the `small-feature` template, the template for the `thin-pr` label, against the committed `HEAD` of the checkout. It works in a temporary git worktree, so your working tree and any uncommitted change stay as they are. The checks from the checkout's `.thin-pr.yml` run in that worktree. A local surface stands in for GitHub. It keeps the text GitHub would get, the draft body or the run report comment, and the command prints it.

- When every gate rule passes, the run commits the change to a new local branch `thin-pr/local-<n>`. `<n>` is one more than the highest existing `thin-pr/local-*` branch. The exit code is 0.
- When a rule or a step fails, the run creates no branch. The exit code is 1. The record keeps the patch.
- Bad arguments print the usage and exit 2.

The RunRecord goes to `<runId>.json` in `--out`, or in `.git/thin-pr/runs` of the checkout by default. That directory sits inside the git directory, so the record never shows up as a change and is never committed. The run id is `local-` plus the start time in milliseconds. A local run has no pull request and no issue page, so `pullRequest` is `null` and `issue.url` is empty.

`THIN_PR_MODEL` picks the model mode, as in the Action. `replay` is the default and reads the cassette at `THIN_PR_CASSETTE`. `live` and `record` need `ANTHROPIC_API_KEY`. This command replays eval case 01 against a copy of `evals/sample-repo`:

```bash
THIN_PR_CASSETTE=evals/cases/01-clamp-decrement/cassette.jsonl \
  pnpm thin-pr run --repo /path/to/sample-repo-copy --issue "Clamp decrement at zero"
```

The sample package checks with bare `tsc` and `vitest`. Put this repo's `node_modules/.bin` on `PATH` for that run, as `pnpm eval` does.

## Connect an MCP client

`packages/mcp` is a stdio MCP server built on `@modelcontextprotocol/sdk`. Its entry is `packages/mcp/bin/thin-pr-mcp.js`. A client that reads a JSON server list takes the entry below. Replace the paths with your own.

```json
{
  "mcpServers": {
    "thin-pr": {
      "command": "node",
      "args": [
        "--disable-warning=ExperimentalWarning",
        "/path/to/thin-pr-orchestrator/packages/mcp/bin/thin-pr-mcp.js"
      ],
      "env": {
        "THIN_PR_RUNS_DIR": "/path/to/checkout/.git/thin-pr/runs"
      }
    }
  }
}
```

`THIN_PR_RUNS_DIR` is the directory `list_runs` and `get_run` read and `start_run` writes. Point it at the default `--out` of a checkout to see the runs the command line made there. To call a model from `start_run`, add `THIN_PR_MODEL` and `ANTHROPIC_API_KEY` to `env`. To replay, add `THIN_PR_CASSETTE`. The flag in `args` hides the `node:sqlite` warning on stderr. The server puts this repo's `node_modules/.bin` on `PATH`, so `replay_case` finds `tsc` and `vitest`.

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `list_runs` | none | One line per RunRecord in `THIN_PR_RUNS_DIR`, newest file first: `runId`, issue title, status, gate summary, and `costUsd`. Files that do not parse as a RunRecord are listed in `skipped`. |
| `get_run` | `runId` | The whole RunRecord with that `runId`. |
| `replay_case` | `caseId`, a directory under `evals/cases` | `verdict`, `failedRules`, `expected`, `correct`, and the RunRecord. |
| `start_run` | `repo`, an absolute path, and `issue`, the issue text | `status`, `branch`, `report`, `recordPath`, and the RunRecord, from the same `runLocal` as the command line. |

`replay_case` copies `evals/sample-repo` and the case's `hidden/` tests into a scratch repo, then calls `runLocal` with the case's cassette. Replay ignores what the tools return, so committing the hidden tests with the base gives the verdict `pnpm eval` gives. It calls no model API.

A tool that fails answers with an MCP tool error, `isError: true` and the message as text. Examples are an unknown `runId`, an unknown `caseId`, a relative `repo`, or `THIN_PR_RUNS_DIR` unset. The server keeps running.

`packages/mcp/src/server.test.ts` connects a client over the SDK's in-memory transport. It lists the tools, reads a temp runs directory, checks the tool errors, and replays `09-failing-hidden-test`. `packages/github/src/cli.test.ts` runs the command line on case 01 against a scratch copy of the sample repo.
