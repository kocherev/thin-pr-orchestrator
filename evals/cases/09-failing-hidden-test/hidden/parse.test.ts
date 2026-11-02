import { expect, it } from "vitest";
import { parseFlag } from "../../src/parse.js";

it("reads TRUE as true", () => {
  expect(parseFlag("TRUE")).toBe(true);
  expect(parseFlag("true")).toBe(true);
});
