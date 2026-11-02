import { expect, it } from "vitest";
import { reset } from "../../src/counter.js";

it("resets to zero", () => {
  expect(reset()).toBe(0);
});
