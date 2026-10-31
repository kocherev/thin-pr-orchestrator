import { describe, expect, it } from "vitest";
import { entrypoint, packageId } from "./index.js";

describe("@thin-pr/github", () => {
  it("reports that the GitHub entry is not wired", () => {
    expect(packageId).toBe("@thin-pr/github");
    expect(entrypoint()).toBe("not-wired");
  });
});
