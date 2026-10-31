import { describe, expect, it } from "vitest";
import { decide, packageId, readiness } from "./index.js";

describe("@thin-pr/gate", () => {
  it("reports that no rules are configured", () => {
    expect(packageId).toBe("@thin-pr/gate");
    expect(readiness()).toBe("unconfigured");
  });

  it("returns the stub decision the orchestrator can call", () => {
    expect(decide()).toBe("pass");
  });
});
