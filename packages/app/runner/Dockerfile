FROM --platform=linux/amd64 node:22-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git sudo acl \
  && rm -rf /var/lib/apt/lists/*
# Target repos install with pnpm or npm. Corepack fetches the pnpm version a repo pins without asking.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Typecheck the whole tree, then keep only the runtime dependencies of @thin-pr/app and its workspace packages.
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && rm -rf node_modules packages/*/node_modules packages/*/dist \
  && pnpm install --frozen-lockfile --prod --offline --filter "@thin-pr/app..."

FROM base
COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml /app/
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/templates /app/templates
COPY --from=build --chown=node:node /app/packages /app/packages
# The commit on thin-pr/<issue> needs an identity, as in the thin-pr workflow.
ENV GIT_AUTHOR_NAME=thin-pr[bot] \
  GIT_AUTHOR_EMAIL=thin-pr@example.invalid \
  GIT_COMMITTER_NAME=thin-pr[bot] \
  GIT_COMMITTER_EMAIL=thin-pr@example.invalid
# Checks run as this user, so code the model wrote cannot read the job's secrets. See docs/security.md.
RUN useradd --create-home thin-pr-check \
  && echo "node ALL=(thin-pr-check) NOPASSWD: ALL" > /etc/sudoers.d/thin-pr-check \
  && chmod 440 /etc/sudoers.d/thin-pr-check
ENV THIN_PR_CHECK_USER=thin-pr-check
USER node
EXPOSE 8080
ENTRYPOINT ["sh", "/app/packages/app/runner/entrypoint.sh"]
