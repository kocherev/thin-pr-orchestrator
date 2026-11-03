import { describe, expect, it } from "vitest";
import { createMemoryWorkspace } from "./memory.js";

const passing = { typecheck: { exitCode: 0, logTail: "" }, test: { exitCode: 0, logTail: "" } };

describe("file tools", () => {
  it("keeps both edits when two replaces on one file run at the same time", async () => {
    const workspace = createMemoryWorkspace({ "src/a.ts": "const a = 1;\nconst b = 1;\n" }, passing);

    await Promise.all([
      workspace.replace("src/a.ts", "const a = 1;", "const a = 2;"),
      workspace.replace("src/a.ts", "const b = 1;", "const b = 2;"),
    ]);

    expect(await workspace.readFile("src/a.ts")).toBe("const a = 2;\nconst b = 2;\n");
  });
});
