#!/usr/bin/env bash
# Runs every repo check in order and stops at the first failure.
set -euo pipefail

for step in lint typecheck test eval eval:judge trace; do
  printf '\n== pnpm %s ==\n' "$step"
  pnpm "$step"
done
