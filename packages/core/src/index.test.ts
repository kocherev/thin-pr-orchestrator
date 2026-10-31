import { describe, expect, it } from "vitest";
import { packageId, ping } from "./index.js";

describe("@thin-pr/core", () => {
  it("answers ping with pong", () => {
    expect(packageId).toBe("@thin-pr/core");
    expect(ping()).toBe("pong");
  });
});
