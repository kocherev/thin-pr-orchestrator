import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bannedSpecifiersIn, packageName, scanDirectory } from "./check-core-boundary.js";

const scriptPath = fileURLToPath(new URL("./check-core-boundary.ts", import.meta.url));
const repoRoot = join(dirname(scriptPath), "..");

describe("core import boundary", () => {
  it("reads the package name from a specifier", () => {
    expect(packageName("openai")).toBe("openai");
    expect(packageName("openai/resources")).toBe("openai");
    expect(packageName("@anthropic-ai/sdk/resources")).toBe("@anthropic-ai/sdk");
    expect(packageName("@thin-pr/core")).toBe("@thin-pr/core");
    expect(packageName("./local")).toBe(".");
  });

  it("flags model client imports and ignores local modules", () => {
    const source = [
      'import OpenAI from "openai";',
      'import "@anthropic-ai/sdk";',
      'export { stream } from "@ai-sdk/openai/internal";',
      'const client = await import("@google/generative-ai");',
      'const ai = require("ai");',
      'import { ping } from "./index.js";',
      'import { listSpecialists } from "@thin-pr/specialists";',
    ].join("\n");

    expect(bannedSpecifiersIn(source)).toEqual([
      "@ai-sdk/openai",
      "@anthropic-ai/sdk",
      "@google/generative-ai",
      "ai",
      "openai",
    ]);
  });

  it("ignores the word openai when it is not an import", () => {
    expect(bannedSpecifiersIn("const note = 'openai is a package name';")).toEqual(
      [],
    );
  });

  it("exits non-zero when a scanned file imports a model client", () => {
    const directory = mkdtempSync(join(tmpdir(), "thin-pr-boundary-"));
    try {
      writeFileSync(join(directory, "client.ts"), 'import client from "openai";\n');
      expect(scanDirectory(directory)).toEqual([
        { file: "client.ts", specifier: "openai" },
      ]);
      const result = spawnNode([
        "--experimental-strip-types",
        scriptPath,
        directory,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('banned model client import "openai"');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails lint when packages/core imports a model client", () => {
    const result = spawnNode(
      [
        join(repoRoot, "node_modules/eslint/bin/eslint.js"),
        "--stdin",
        "--stdin-filename",
        "packages/core/src/banned-import.ts",
      ],
      'import client from "openai";\n',
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Model clients are not allowed in packages/core",
    );
  });
});

function spawnNode(args: readonly string[], input?: string) {
  try {
    const stdout = execFileSync(process.execPath, [...args], {
      cwd: repoRoot,
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failed.status ?? 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}
