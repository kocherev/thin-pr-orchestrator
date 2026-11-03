# Install the Action on your repo

thin-pr runs as a GitHub Action from `action.yml` at the root of this repo. This repo's own `.github/workflows/thin-pr.yml` runs the same Action with `uses: ./`.

## What you need

- **An `ANTHROPIC_API_KEY` repository secret.**
- **Settings > Actions > General > "Allow GitHub Actions to create and approve pull requests" turned on,** so the workflow token can open the draft. Repository workflow permissions can stay read-only, because the job asks for what it needs.
- **The labels:**
  - `thin-pr`, the feature template
  - `thin-pr:bugfix`
  - `thin-pr:docs`
- **A `.thin-pr.yml` at the repo root.** It sets the install, the two checks and the path rules. See below.
- **The workflow file below on the default branch.** GitHub runs `issues` and comment events only from there.

## The workflow

Save it as `.github/workflows/thin-pr.yml`. Replace `<commit sha>` with a full commit SHA from this repo, so an update here never changes what runs on your repo until you move the pin. The job condition repeats the router's checks, so the runner doesn't start for other labels, plain comments, outsiders or bots. Keep it as it is.

```yaml
name: Thin PR

on:
  issues:
    types: [labeled]
  issue_comment:
    types: [created]
  pull_request_review:
    types: [submitted]
  pull_request_review_comment:
    types: [created]

permissions: {}

# One run at a time per issue or pull request, so a command waits for the run it acts on, and the events for one
# review queue behind its revise run, which then finds the reply and stops.
concurrency:
  group: thin-pr-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  orchestrate:
    # The router in packages/github decides what each event does. This condition only keeps the runner from
    # starting for events it would ignore: other labels, plain comments, approvals, other branches, outsiders and bots.
    if: >-
      github.event.sender.type != 'Bot' && (
        (github.event_name == 'issues'
          && (github.event.label.name == 'thin-pr' || startsWith(github.event.label.name, 'thin-pr:')))
        || (github.event_name == 'issue_comment'
          && startsWith(github.event.comment.body, '/thin-pr')
          && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association))
        || (github.event_name == 'pull_request_review'
          && startsWith(github.event.pull_request.head.ref, 'thin-pr/')
          && github.event.review.state != 'approved'
          && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.review.author_association))
        || (github.event_name == 'pull_request_review_comment'
          && startsWith(github.event.pull_request.head.ref, 'thin-pr/')
          && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association))
      )
    runs-on: ubuntu-latest
    timeout-minutes: 30
    # contents: push the branch, and delete it on cancel. checks: one check per step and rule. issues: the progress
    # comment and command replies. pull-requests: open or update the draft, read reviews, reply on the draft.
    permissions:
      contents: write
      checks: write
      issues: write
      pull-requests: write
    steps:
      # Full history, so a second label can force-push thin-pr/<issue> with a lease. No stored credentials:
      # the checks run repo code, and only the push gets the token. A review checks out the draft branch.
      - name: Checkout
        uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.head.ref }}
          fetch-depth: 0
          persist-credentials: false

      # Your repo's own toolchain, so the install and checks in .thin-pr.yml can run. This example is pnpm and uv.
      - name: Install pnpm
        uses: pnpm/action-setup@v6

      - name: Install uv
        uses: astral-sh/setup-uv@v10

      - name: Run thin-pr
        uses: kocherev/thin-pr-orchestrator@<commit sha>
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## What the Action does

1. Sets up Node from this repo's `.nvmrc`. Later steps in the job see that Node too.
2. Installs only thin-pr's runtime packages, in the Action's own folder, never in your checkout.
3. Creates the user `thin-pr-check`. Your install and checks run as that user, so code the model wrote cannot read the API key or the token. See `docs/security.md`.
4. Runs the event from your checkout, which is the working directory.
5. Uploads the run's trace as the `thin-pr-trace` artifact. Set `otel-endpoint` and `otel-headers` to send it to an OTLP backend instead. See `docs/telemetry.md`.

## Inputs

| Input | Default | What it is |
| --- | --- | --- |
| `anthropic-api-key` | required | The key for the model calls. |
| `github-token` | `github.token` | The token that comments, pushes `thin-pr/<issue>`, and opens the draft. |
| `otel-endpoint` | empty | An OTLP endpoint for the trace. |
| `otel-headers` | empty | Headers for that endpoint, such as its API key. |
| `trace-artifact` | `thin-pr-trace` | The artifact name, when one workflow runs thin-pr twice. |

## `.thin-pr.yml`

```yaml
install: pnpm install --frozen-lockfile && uv sync --frozen --all-packages --group dev
checks:
  typecheck: pnpm lint && pnpm typecheck && uv run ruff check . && uv run pyright
  test: pnpm test && uv run pytest
paths:
  allow: ["**"]
  deny: [".github/**", "**/.env", "**/.env.local", "**/.env.*.local", "pnpm-lock.yaml", "uv.lock"]
```

Each field has a default, so a file can set only what differs. `templates/README.md` lists the budget and spend fields. Name only real secret files in `deny`. A broad pattern such as `**/.env*` also blocks `.env.example`, which an issue may need to change. The `secrets` gate rule scans every added line whatever the paths.

## Try it first

`pnpm thin-pr run --repo <checkout> --issue issue.md --config thin-pr.yml` runs an issue locally against a checkout, with the config kept outside it. Nothing is pushed. `evals/kb-copilot/README.md` shows ten such runs on a real repo.
