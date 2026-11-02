# Deploy the GitHub App on Cloudflare

`packages/app` is a Cloudflare Worker. It receives the `issues` webhook, checks the signature, and puts one job on the `pr-jobs` queue. The queue consumer mints an installation token and starts one container per delivery. The container clones the default branch and runs the issue through `runLabeledIssue`, the same function the Action calls. It prints the run record as one JSON line when the run ends.

You need a Cloudflare account with Workers Paid (Containers require it), Docker running locally, `gh` logged in as the repository owner, `jq`, and `openssl`. Run every command from the repo root unless a step says otherwise.

## 1. Create the GitHub App

The manifest is `packages/app/github-app-manifest.json`. It asks for checks, contents, issues, and pull requests with write access, actions and metadata with read access, and the `issues` event. Actions read lets the Worker see whether the thin-pr workflow is enabled. The webhook starts inactive because the Worker URL does not exist yet.

Write a form that posts the manifest to GitHub, then open it:

```bash
printf '<form action="https://github.com/settings/apps/new" method="post"><input type="hidden" name="manifest" value='"'"'%s'"'"'><button>Create GitHub App</button></form>\n' \
  "$(jq -c . packages/app/github-app-manifest.json)" > /tmp/thin-pr-app.html
open /tmp/thin-pr-app.html
```

Click the button. GitHub shows the app name. Change it if `thin-pr` is taken, then create the app.

GitHub redirects to the repository with `?code=` in the address bar. Exchange that code within one hour. The response holds the private key, the webhook secret, and the client ID. Keep the file outside the repository.

```bash
gh api -X POST /app-manifests/<code>/conversions > ~/thin-pr-app.json
```

GitHub issues a PKCS#1 key. Web Crypto in Workers reads only PKCS#8. Convert it:

```bash
jq -r .pem ~/thin-pr-app.json > ~/thin-pr-app.pem
openssl pkcs8 -topk8 -nocrypt -in ~/thin-pr-app.pem -out ~/thin-pr-app.pkcs8.pem
```

Install the app on the repository: open the app page from `jq -r .html_url ~/thin-pr-app.json`, choose Install App, and select only this repository.

## 2. Log in to Cloudflare and create the queue

The remaining commands run from `packages/app`.

```bash
cd packages/app
pnpm exec wrangler login
pnpm exec wrangler queues create pr-jobs
```

The dead-letter queue `pr-jobs-dlq` is created on the first deploy.

## 3. Set the secrets

`wrangler.jsonc` lists four required secrets. Deploy fails until all four exist. The first `secret put` offers to create the `thin-pr-app` Worker. Answer yes.

```bash
jq -r .webhook_secret ~/thin-pr-app.json | pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
jq -r .client_id ~/thin-pr-app.json | pnpm exec wrangler secret put GITHUB_APP_CLIENT_ID
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < ~/thin-pr-app.pkcs8.pem
pnpm exec wrangler secret put ANTHROPIC_API_KEY
```

The last command prompts for the key. `THIN_PR_MODEL` and `THIN_PR_SPEND_LIMIT_USD` are plain variables in `wrangler.jsonc`.

## 4. Deploy

```bash
pnpm exec wrangler deploy
```

Wrangler builds `runner/Dockerfile` with the repo root as context, pushes the image, and deploys the Worker. It prints the Worker URL, `https://thin-pr-app.<your-subdomain>.workers.dev`. The first container rollout can take a few minutes.

## 5. Point the webhook at the Worker

Open the app settings. Set Webhook URL to the Worker URL. Check Active. Save.

GitHub sends a `ping`. Recent Deliveries shows `204` for it. Label an issue `thin-pr`. That delivery shows `202`. `pnpm exec wrangler tail` shows the queue consumer's line for the delivery. The container's logs in the Cloudflare dashboard end with the run record.

## 6. Send traces (optional)

App runs export a trace only when `OTEL_EXPORTER_OTLP_ENDPOINT` names a collector. Set it in `vars` in `wrangler.jsonc`, for example `"OTEL_EXPORTER_OTLP_ENDPOINT": "https://api.honeycomb.io"`. The endpoint must use port 443 or 80, because the container can reach nothing else. The Runner adds its host to the egress allowlist. If the collector needs an API key, store the headers as a secret, then deploy again:

```bash
pnpm exec wrangler secret put OTEL_EXPORTER_OTLP_HEADERS
pnpm exec wrangler deploy
```

The container sends the trace when the run ends. `docs/telemetry.md` lists the spans and the values for each backend.

## Action or App

The Action and the App answer the same `thin-pr` label. One rule decides which one runs: the App defers to an enabled thin-pr workflow.

- The workflow `.github/workflows/thin-pr.yml` is enabled: the Action runs. The App acks the job and does nothing.
- The workflow is disabled or absent: the App runs.

To hand a repository to the App, run `gh workflow disable thin-pr.yml`. Run `gh workflow enable thin-pr.yml` to go back to the Action.

## Container lifetime

A run can outlast the 15 minutes a queue consumer may wait, so `POST /run` answers 202 at once and the run continues in the background. When `sleepAfter` passes, the Worker asks the container's `GET /status` and stops it only when no run is in progress.

The container runs as the `node` user. When Cloudflare intercepts HTTPS egress, it writes its CA at start. A non-root process cannot update the system store, so the entrypoint appends that CA to a bundle in `/tmp` and points Node and git at it.

## Check before you deploy

These run without a Cloudflare login:

```bash
pnpm --filter @thin-pr/app test
pnpm --filter @thin-pr/app exec wrangler deploy --dry-run --outdir dist
```

The dry run builds the container image, so Docker must be running.
