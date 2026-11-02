import { expect, it } from "vitest";
import { splitNotes } from "../../src/notes.js";

it("drops empty lines", () => {
  expect(splitNotes("a\n\nb\n")).toEqual(["a", "b"]);
});
