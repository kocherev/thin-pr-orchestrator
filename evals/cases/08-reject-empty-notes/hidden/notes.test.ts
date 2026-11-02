import { expect, it } from "vitest";
import { splitNotes } from "../../src/notes.js";

it("returns no lines for blank text", () => {
  expect(splitNotes("   ")).toEqual([]);
  expect(splitNotes("a")).toEqual(["a"]);
});
