import { describe, expect, it } from "vitest";
import { bannedSpecifiersIn, packageName } from "./check-core-boundary.js";

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
});
