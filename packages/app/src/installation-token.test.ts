import { beforeAll, describe, expect, it } from "vitest";
import { createAppJwt, createInstallationToken, type AppCredentials } from "./installation-token.js";

const NOW_MS = Date.UTC(2026, 10, 2, 12, 0, 0);
const NOW = NOW_MS / 1000;
const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

let app: AppCredentials;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { ...ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair)) {
    throw new Error("expected an RSA key pair");
  }
  const exported = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(exported instanceof ArrayBuffer)) {
    throw new Error("expected PKCS#8 bytes");
  }
  const der = new Uint8Array(exported);
  const base64 = btoa(String.fromCharCode(...der));
  const lines = base64.match(/.{1,64}/g) ?? [];
  app = {
    clientId: "Iv23liExample",
    privateKeyPem: ["-----BEGIN PRIVATE KEY-----", ...lines, "-----END PRIVATE KEY-----", ""].join("\n"),
  };
  publicKey = pair.publicKey;
});

function decodeSegment(segment: string): unknown {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
}

function decodeSignature(segment: string): Uint8Array<ArrayBuffer> {
  const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

describe("createAppJwt", () => {
  it("signs an RS256 token that GitHub accepts for ten minutes at most", async () => {
    const jwt = await createAppJwt(app, NOW_MS);
    const [header, claims, signature] = jwt.split(".");
    expect(decodeSegment(header ?? "")).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeSegment(claims ?? "")).toEqual({ iat: NOW - 60, exp: NOW + 540, iss: "Iv23liExample" });
    const valid = await crypto.subtle.verify(
      ALGORITHM,
      publicKey,
      decodeSignature(signature ?? ""),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it("names the conversion when the key is PKCS#1", async () => {
    const pkcs1 = app.privateKeyPem.replace(/PRIVATE KEY/g, "RSA PRIVATE KEY");
    await expect(createAppJwt({ ...app, privateKeyPem: pkcs1 })).rejects.toThrow("openssl pkcs8 -topk8 -nocrypt");
  });
});

describe("createInstallationToken", () => {
  it("exchanges the app token for a token scoped to one repository", async () => {
    const requests: Request[] = [];
    const token = await createInstallationToken({
      app,
      installationId: 42,
      repository: "sample-repo",
      nowMs: NOW_MS,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ token: "ghs_example", expires_at: "2026-11-02T13:00:00Z" }, { status: 201 });
      },
    });

    expect(token).toEqual({ token: "ghs_example", expiresAt: "2026-11-02T13:00:00Z" });
    const request = requests[0];
    expect(requests).toHaveLength(1);
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${await createAppJwt(app, NOW_MS)}`);
    expect(await request?.json()).toEqual({ repositories: ["sample-repo"] });
  });

  it("fails with GitHub's status when the exchange is refused", async () => {
    const refused = createInstallationToken({
      app,
      installationId: 42,
      fetch: async () => Response.json({ message: "Bad credentials" }, { status: 401 }),
    });
    await expect(refused).rejects.toThrow('GitHub returned 401 for installation 42: {"message":"Bad credentials"}');
  });
});
