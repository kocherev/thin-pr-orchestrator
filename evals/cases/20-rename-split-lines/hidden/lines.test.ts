import { expect, it } from "vitest";
import * as notes from "../../src/notes.js";

it("exports splitLines and no longer exports splitNotes", () => {
  expect(notes.splitLines("buy milk\ncall home")).toEqual(["buy milk", "call home"]);
  expect("splitNotes" in notes).toBe(false);
});
