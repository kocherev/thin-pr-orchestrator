import { describe, expect, it } from "vitest";
import { entrypoint, packageId, TRIGGER_LABEL } from "./index.js";

describe("@thin-pr/github", () => {
  it("starts from an issue label", () => {
    expect(packageId).toBe("@thin-pr/github");
    expect(entrypoint()).toBe("issue-label");
    expect(TRIGGER_LABEL).toBe("thin-pr");
  });
});
