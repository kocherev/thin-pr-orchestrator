import { expect, it } from "vitest";
import { decrement } from "../../src/counter.js";

it("stops decrement at zero", () => {
  expect(decrement(0)).toBe(0);
  expect(decrement(5)).toBe(4);
});
