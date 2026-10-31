# Contributing

Run these before opening a pull request:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Keep model client imports out of `packages/core`. `pnpm lint` runs that check.

Do not commit `.env` or tokens. New variable names go in `.env.example` with a placeholder value.
