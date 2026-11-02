import { expect, it } from "vitest";
import { formatCount } from "../../src/format.js";

it("renders counts in compact form", () => {
  expect(formatCount(42)).toBe("42");
  expect(formatCount(1000)).toBe("1k");
  expect(formatCount(1240)).toBe("1.2k");
  expect(formatCount(3_400_000)).toBe("3.4M");
});

it("moves to the next unit when rounding reaches it", () => {
  expect(formatCount(999_999)).toBe("1M");
});
