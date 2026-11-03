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

  it("runs the edits after a failed one in the same turn", async () => {
    const workspace = createMemoryWorkspace({ "src/a.ts": "const a = 1;\nconst b = 1;\n" }, passing);

    const edits = await Promise.allSettled([
      workspace.replace("src/a.ts", "const a = 1;", "const a = 2;"),
      workspace.replace("src/a.ts", "const c = 1;", "const c = 2;"),
      workspace.replace("src/a.ts", "const b = 1;", "const b = 2;"),
    ]);

    expect(edits.map((edit) => edit.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(await workspace.readFile("src/a.ts")).toBe("const a = 2;\nconst b = 2;\n");
  });
});
