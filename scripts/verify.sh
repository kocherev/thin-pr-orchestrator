#!/usr/bin/env bash
# Runs every repo check in order and stops at the first failure.
set -euo pipefail

for step in lint typecheck test eval eval:judge; do
  printf '\n== pnpm %s ==\n' "$step"
  pnpm "$step"
done

# The trace goes to a temp file, so the output is the span summary instead of the OTLP JSON.
printf '\n== pnpm trace ==\n'
trace_file="$(mktemp "${TMPDIR:-/tmp}/thin-pr-trace.XXXXXX")"
trap 'rm -f "$trace_file"' EXIT
THIN_PR_TRACE_PATH="$trace_file" pnpm trace
