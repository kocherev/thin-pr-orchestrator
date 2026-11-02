FROM --platform=linux/amd64 node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

EXPOSE 8080
ENTRYPOINT ["sh", "packages/app/runner/entrypoint.sh"]
