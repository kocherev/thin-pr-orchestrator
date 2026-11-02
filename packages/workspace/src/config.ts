import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const command = z.string().min(1);
const glob = z.string().min(1);
const limit = z.number().int().positive();

// Each field has its own default, so a file can override one value and keep the rest.
const repoConfigSchema = z
  .object({
    checks: z
      .object({ typecheck: command.default("pnpm exec tsc --noEmit"), test: command.default("pnpm exec vitest run") })
      .strict()
      .prefault({}),
    // Optional: a checkout that already has its dependencies needs no install.
    install: command.optional(),
    budget: z.object({ max_files: limit.default(2), max_lines: limit.default(16) }).strict().prefault({}),
    paths: z
      .object({
        allow: z.array(glob).min(1).default(["src/**", "test/**", "examples/**", "README.md", "docs/**"]),
        deny: z.array(glob).default([".github/**", "**/.env*", "pnpm-lock.yaml", "package-lock.json"]),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/** The target repo's constraints from `.thin-pr.yml`, with defaults for every missing field. */
export type RepoConfig = z.infer<typeof repoConfigSchema>;

export const DEFAULT_CONFIG: RepoConfig = repoConfigSchema.parse({});

/** Reads `.thin-pr.yml` at the root of `dir`. A missing or empty file gives the defaults. */
export function loadRepoConfig(dir: string): RepoConfig {
  const path = join(dir, ".thin-pr.yml");
  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }
  let value: unknown;
  try {
    value = parse(readFileSync(path, "utf8")) ?? {};
  } catch (error) {
    throw new Error(`.thin-pr.yml is not valid YAML: ${error instanceof Error ? error.message : "parse failed"}`, {
      cause: error,
    });
  }
  const parsed = repoConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`.thin-pr.yml invalid at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}
