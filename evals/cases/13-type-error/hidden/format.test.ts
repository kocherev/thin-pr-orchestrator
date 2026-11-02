import { expect, it } from "vitest";
import { formatPercent } from "../../src/format.js";

it("renders a ratio as a percent", () => {
  expect(formatPercent(0.25)).toBe("25%");
});
