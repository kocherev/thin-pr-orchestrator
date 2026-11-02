# Contributing

Read `AGENTS.md` before changing the repo. It covers the install, each check, the skills under `.agents/skills/`, and the commit and branch rules.

Run these before opening a pull request:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm eval
pnpm eval:judge
pnpm trace
```

Keep model client imports out of `packages/core`. `pnpm lint` runs that check.

Do not commit `.env` or tokens. New variable names go in `.env.example` with a placeholder value.
