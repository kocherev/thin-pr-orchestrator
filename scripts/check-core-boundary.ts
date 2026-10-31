import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Package names that must not be imported from packages/core.
 * eslint.config.js bans the same names as static imports.
 * This script also rejects require() and dynamic import().
 */
export const BANNED_PACKAGES = [
  "openai",
  "@anthropic-ai/sdk",
  "@ai-sdk/anthropic",
  "@ai-sdk/openai",
  "@ai-sdk/google",
  "@google/generative-ai",
  "ai",
] as const;

const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
] as const;

export function packageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    if (scope && name) {
      return `${scope}/${name}`;
    }
  }
  const root = specifier.split("/")[0];
  return root ?? specifier;
}

export function bannedSpecifiersIn(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier) {
        continue;
      }
      const name = packageName(specifier);
      if ((BANNED_PACKAGES as readonly string[]).includes(name)) {
        found.add(name);
      }
    }
  }
  return [...found].sort();
}

export type BoundaryHit = {
  readonly file: string;
  readonly specifier: string;
};

export function scanDirectory(root: string): BoundaryHit[] {
  const hits: BoundaryHit[] = [];
  for (const file of typescriptFiles(root)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of bannedSpecifiersIn(source)) {
      hits.push({ file: relative(root, file), specifier });
    }
  }
  return hits;
}

function typescriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...typescriptFiles(path));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(path);
    }
  }
  return files;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return resolve(entry) === fileURLToPath(import.meta.url);
}

export function checkBoundary(root: string): number {
  const hits = scanDirectory(root);
  for (const hit of hits) {
    process.stderr.write(`${hit.file}: banned model client import "${hit.specifier}"\n`);
  }
  return hits.length === 0 ? 0 : 1;
}

if (isDirectRun()) {
  const coreRoot = join(dirname(fileURLToPath(import.meta.url)), "../packages/core");
  const requested = process.argv[2];
  process.exit(checkBoundary(requested ? resolve(requested) : coreRoot));
}
