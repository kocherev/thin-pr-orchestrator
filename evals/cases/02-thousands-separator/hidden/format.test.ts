import { expect, it } from "vitest";
import { formatCount } from "../../src/format.js";

it("groups thousands", () => {
  expect(formatCount(1234567)).toBe("1,234,567");
  expect(formatCount(42)).toBe("42");
});
