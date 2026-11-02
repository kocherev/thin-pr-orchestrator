import { expect, it } from "vitest";
import { splitNotes } from "../src/notes.js";

it("splits text into lines", () => {
  expect(splitNotes("buy milk\ncall home")).toEqual(["buy milk", "call home"]);
});
