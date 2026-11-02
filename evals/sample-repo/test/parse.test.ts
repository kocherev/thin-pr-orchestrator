import { expect, it } from "vitest";
import { parseFlag } from "../src/parse.js";

it("reads true and false and rejects other words", () => {
  expect(parseFlag("true")).toBe(true);
  expect(parseFlag("false")).toBe(false);
  expect(parseFlag("maybe")).toBeNull();
});
