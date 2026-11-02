import { expect, it } from "vitest";
import { requestHeaders } from "../../src/client.js";

it("sends JSON", () => {
  expect(requestHeaders()["content-type"]).toBe("application/json");
});
