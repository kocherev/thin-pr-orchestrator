import { expect, it } from "vitest";
import { formatLabel } from "../../src/format.js";

it("uppercases a label", () => {
  expect(formatLabel("draft")).toBe("DRAFT");
});
