import { describe, expect, it } from "vitest";
import { verifySignature } from "./signature.js";

// The example from GitHub's "Validating webhook deliveries" guide.
const SECRET = "It's a Secret to Everybody";
const BODY = new TextEncoder().encode("Hello, World!");
const SIGNATURE = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

function body(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

describe("verifySignature", () => {
  it("accepts GitHub's documented signature", async () => {
    expect(await verifySignature(SECRET, body(BODY), SIGNATURE)).toBe(true);
  });

  it("rejects a body that changed after signing", async () => {
    const changed = new TextEncoder().encode("Hello, World?");
    expect(await verifySignature(SECRET, body(changed), SIGNATURE)).toBe(false);
  });

  it("rejects the right body signed with another secret", async () => {
    expect(await verifySignature("another secret", body(BODY), SIGNATURE)).toBe(false);
  });

  it("rejects a missing or malformed header", async () => {
    expect(await verifySignature(SECRET, body(BODY), null)).toBe(false);
    expect(await verifySignature(SECRET, body(BODY), SIGNATURE.replace("sha256=", "sha1="))).toBe(false);
    expect(await verifySignature(SECRET, body(BODY), SIGNATURE.slice(0, -2))).toBe(false);
    expect(await verifySignature(SECRET, body(BODY), SIGNATURE.toUpperCase())).toBe(false);
  });
});
