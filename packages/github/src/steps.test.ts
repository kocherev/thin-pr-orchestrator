import type { StepContext, StepId } from "@thin-pr/core";
import { ReplayModelClient } from "@thin-pr/specialists";
import { createMemoryWorkspace, type GitWorkspace } from "@thin-pr/workspace";
import { describe, expect, it } from "vitest";
import { createRunHandlers, createVerifyHandler } from "./steps.js";

const passing = { exitCode: 0, logTail: "" };
const failingTest = { exitCode: 1, logTail: "FAIL test/counter.test.ts > clamps at zero" };

describe("verify", () => {
  it("finishes with both check results when they pass", async () => {
    const verify = createVerifyHandler(installable({}, { typecheck: passing, test: passing }));

    const result = await verify(context("verify", 0));
    expect(result).toEqual({
      outcome: "done",
      output: {
        summary: "typecheck passed; test passed.",
        checks: [
          { name: "typecheck", command: "pnpm exec tsc --noEmit", exitCode: 0, durationMs: 0, logTail: "" },
          { name: "test", command: "pnpm exec vitest run", exitCode: 0, durationMs: 0, logTail: "" },
        ],
      },
    });
  });

  it("loops back with the failing check and its log tail", async () => {
    const verify = createVerifyHandler(installable({}, { typecheck: passing, test: failingTest }));

    const result = await verify(context("verify", 0));
    expect(result).toMatchObject({
      outcome: "loop",
      output: { summary: "typecheck passed; test failed (exit 1)." },
      feedback: "test failed (exit 1): pnpm exec vitest run\nFAIL test/counter.test.ts > clamps at zero",
    });
  });

  it("finishes with the failure once the template allows no more loops", async () => {
    const verify = createVerifyHandler(installable({}, { typecheck: passing, test: failingTest }));

    expect((await verify(context("verify", 2))).outcome).toBe("done");
    expect((await verify({ ...context("verify", 0), step: { id: "verify", retries: 0 } })).outcome).toBe("done");
  });
});

describe("install", () => {
  it("runs once before the first checks", async () => {
    let installs = 0;
    const verify = createVerifyHandler(
      installable({}, { typecheck: passing, test: failingTest }, async () => {
        installs += 1;
        return { command: "pnpm install --frozen-lockfile", exitCode: 0, durationMs: 0, logTail: "" };
      }),
    );

    await verify(context("verify", 0));
    await verify(context("verify", 1));
    expect(installs).toBe(1);
  });

  it("fails verify with the install log tail", async () => {
    const verify = createVerifyHandler(
      installable({}, { typecheck: passing, test: passing }, async () => ({
        command: "pnpm install --frozen-lockfile",
        exitCode: 1,
        durationMs: 0,
        logTail: "ERR_PNPM_OUTDATED_LOCKFILE",
      })),
    );

    await expect(verify(context("verify", 0))).rejects.toThrow(
      "install failed (exit 1): pnpm install --frozen-lockfile\nERR_PNPM_OUTDATED_LOCKFILE",
    );
  });
});

describe("implement", () => {
  it("applies each edit to the workspace as a new file or a full replace", async () => {
    const workspace = installable(
      { "src/counter.ts": "export const count = 1;\n" },
      { typecheck: passing, test: passing },
    );
    const implementer = JSON.stringify({
      summary: "Change the count and add reset.",
      files: ["src/counter.ts", "src/reset.ts"],
      edits: [
        { path: "src/counter.ts", content: "export const count = 2;\n" },
        { path: "src/reset.ts", content: "export const reset = 0;\n" },
      ],
    });
    const { implement } = createRunHandlers(new ReplayModelClient({ implementer }), workspace);

    const outputs = { plan: { summary: "Change the count.", steps: ["Edit src/counter.ts"] } };
    await implement({ ...context("implement", 0), outputs });
    // A loop that returns the same files leaves the workspace as it was.
    await implement({ ...context("implement", 1), outputs });

    expect(await workspace.readFile("src/counter.ts")).toBe("export const count = 2;\n");
    expect(await workspace.readFile("src/reset.ts")).toBe("export const reset = 0;\n");
    expect((await workspace.diff()).files.map((file) => file.path)).toEqual(["src/counter.ts", "src/reset.ts"]);
  });
});

function installable(
  files: Parameters<typeof createMemoryWorkspace>[0],
  checks: Parameters<typeof createMemoryWorkspace>[1],
  install: GitWorkspace["install"] = async () => null,
) {
  return { ...createMemoryWorkspace(files, checks), install };
}

function context(step: StepId, loop: number): StepContext {
  return {
    runId: "run-7",
    issue: "#7 Clamp decrement at zero",
    step: { id: step, retries: 0, loop: { back_to: "implement", max: 2 } },
    outputs: {},
    feedback: null,
    attempt: 1,
    loop,
  };
}
