import { expect, it } from "vitest";
import { decrementBy } from "../../src/counter.js";

it("subtracts the step", () => {
  expect(decrementBy(5, 2)).toBe(3);
});
