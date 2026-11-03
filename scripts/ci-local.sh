#!/usr/bin/env bash
# Runs the CI jobs from .github/workflows/ci.yml on the committed HEAD before a push, where they differ from
# `pnpm verify` on this machine:
# the check and action jobs on Linux in a container, with a real second user for the sandbox test, gitleaks at the
# version CI uses on the commits about to be pushed, and the console and deploy-check builds. Commit first: the
# Linux jobs see only what is committed. Needs Docker.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
base="${1:-origin/main}"
node_image="node:22"
gitleaks_image="zricethezav/gitleaks:v8.24.3"

step() { printf '\n== %s ==\n' "$1"; }

step "secrets: gitleaks on $base..HEAD"
if [ -n "$(git -C "$root" rev-list "$base..HEAD")" ]; then
  docker run --rm -v "$root:/repo:ro" "$gitleaks_image" detect --source /repo --redact --no-banner \
    --log-opts="--no-merges --first-parent $base..HEAD"
else
  echo "no commits to scan"
fi

step "check and action: Linux, as on ubuntu-latest"
# The committed tree, as actions/checkout sees it: no node_modules, no build output, no uncommitted files. The pnpm
# store volume keeps reruns fast.
git -C "$root" archive --format=tar HEAD | docker run --rm -i -v thin-pr-ci-pnpm-store:/pnpm-store "$node_image" bash -euo pipefail -c '
  apt-get update -qq > /dev/null && apt-get install -y -qq sudo acl > /dev/null
  useradd --create-home runner && echo "runner ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/runner
  # A 750 home folder, as on Ubuntu, so the sandbox test meets the same permissions as on a runner.
  chmod 750 /home/runner && mkdir -p /home/runner/work/repo /home/runner/work/action
  tar -x -C /home/runner/work/repo
  cp -a /home/runner/work/repo/. /home/runner/work/action/
  chown -R runner /home/runner/work /pnpm-store
  corepack enable > /dev/null 2>&1
  as_runner() { sudo -u runner -H env PATH="$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_store_dir=/pnpm-store "$@"; }
  cd /home/runner/work/repo
  as_runner pnpm install --frozen-lockfile --silent
  as_runner pnpm verify
  echo "== sandbox =="
  useradd --no-create-home --home-dir /home/thin-pr-check thin-pr-check
  install -d -o thin-pr-check -g thin-pr-check -m 700 /home/thin-pr-check
  as_runner env THIN_PR_CANARY_KEY=canary-local THIN_PR_CHECK_USER=thin-pr-check pnpm test:sandbox
  echo "== action: fresh install from its own folder, run from another checkout =="
  cd /home/runner/work/action
  as_runner npx --yes pnpm@10.33.4 install --frozen-lockfile --prod --filter "@thin-pr/github..." --silent
  mkdir -p /tmp/target && cd /tmp/target && git init -q && chown -R runner /tmp/target
  echo "{\"action\":\"opened\",\"number\":1}" > /tmp/event.json
  as_runner env GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH=/tmp/event.json GITHUB_TOKEN=unused \
    ANTHROPIC_API_KEY=unused THIN_PR_TRACE_PATH=/tmp/thin-pr/trace.json \
    node --experimental-sqlite --disable-warning=ExperimentalWarning /home/runner/work/action/packages/github/bin/action.js
  test -s /tmp/thin-pr/trace.json && test -z "$(git status --porcelain)"
'

cd "$root"
step "install on this machine, as CI does"
pnpm install --frozen-lockfile

step "console: build and Wrangler dry run"
pnpm console:build
pnpm --filter console exec wrangler deploy --dry-run

step "deploy-check: Worker types and Wrangler dry run"
pnpm --filter @thin-pr/app exec wrangler types --check
pnpm --filter @thin-pr/app exec wrangler deploy --dry-run --outdir dist

printf '\nci:local passed: secrets, check, sandbox, action, console, deploy-check.\n'
