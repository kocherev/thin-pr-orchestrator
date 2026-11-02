import { expect, it } from "vitest";
import { parseFlag } from "../../src/parse.js";

it("reads yes and no", () => {
  expect(parseFlag("yes")).toBe(true);
  expect(parseFlag("no")).toBe(false);
});
