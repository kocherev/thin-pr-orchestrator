import { expect, it } from "vitest";
import { formatCount } from "../src/format.js";

it("renders a small count as digits", () => {
  expect(formatCount(42)).toBe("42");
});
