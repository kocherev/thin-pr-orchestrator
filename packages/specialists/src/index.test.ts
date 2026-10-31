import { describe, expect, it } from "vitest";
import { listSpecialists, packageId } from "./index.js";

describe("@thin-pr/specialists", () => {
  it("exports an empty registry", () => {
    expect(packageId).toBe("@thin-pr/specialists");
    expect(listSpecialists()).toEqual([]);
  });
});
