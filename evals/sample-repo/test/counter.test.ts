import { expect, it } from "vitest";
import { decrement, increment } from "../src/counter.js";

it("adds and subtracts one", () => {
  expect(increment(1)).toBe(2);
  expect(decrement(3)).toBe(2);
});
