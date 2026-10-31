import { describe, expect, it } from "vitest";
import { packageId, readiness } from "./index.js";

describe("@thin-pr/gate", () => {
  it("reports that no rules are configured", () => {
    expect(packageId).toBe("@thin-pr/gate");
    expect(readiness()).toBe("unconfigured");
  });
});
