import { expect, it } from "vitest";
import { notesWithTag } from "../../src/notes.js";

it("matches a tag with or without # and in any case", () => {
  const text = "buy milk #home\ncall mom #Family #home\nfile taxes #work";
  expect(notesWithTag(text, "#HOME")).toEqual(["buy milk #home", "call mom #Family #home"]);
  expect(notesWithTag(text, "family")).toEqual(["call mom #Family #home"]);
  expect(notesWithTag(text, "garden")).toEqual([]);
});
