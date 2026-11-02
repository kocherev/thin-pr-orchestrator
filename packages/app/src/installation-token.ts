import { z } from "zod";

export type AppCredentials = {
  readonly clientId: string;
  readonly privateKeyPem: string;
};

export type InstallationToken = {
  readonly token: string;
  readonly expiresAt: string;
};

const tokenResponseSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().min(1),
});

const PKCS8_HEADER = "-----BEGIN PRIVATE KEY-----";
const PKCS8_FOOTER = "-----END PRIVATE KEY-----";

export function githubHeaders(authorization: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization,
    "user-agent": "thin-pr-orchestrator",
    "x-github-api-version": "2022-11-28",
  };
}

export async function createAppJwt(app: AppCredentials, nowMs: number = Date.now()): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  // GitHub rejects an exp more than 10 minutes after iat; the backdated iat absorbs clock drift.
  const claims = encodeJson({ iat: now - 60, exp: now + 9 * 60, iss: app.clientId });
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    readPkcs8(app.privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

export async function createInstallationToken(input: {
  readonly app: AppCredentials;
  readonly installationId: number;
  readonly repository?: string;
  readonly fetch: typeof fetch;
  readonly nowMs?: number;
}): Promise<InstallationToken> {
  const jwt = await createAppJwt(input.app, input.nowMs);
  const response = await input.fetch(
    `https://api.github.com/app/installations/${input.installationId}/access_tokens`,
    {
      method: "POST",
      headers: githubHeaders(`Bearer ${jwt}`),
      body: input.repository === undefined ? null : JSON.stringify({ repositories: [input.repository] }),
    },
  );
  if (response.status !== 201) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`GitHub returned ${response.status} for installation ${input.installationId}: ${detail}`);
  }
  const parsed = tokenResponseSchema.parse(await response.json());
  return { token: parsed.token, expiresAt: parsed.expires_at };
}

function readPkcs8(pem: string): ArrayBuffer {
  const trimmed = pem.trim();
  if (!trimmed.startsWith(PKCS8_HEADER) || !trimmed.endsWith(PKCS8_FOOTER)) {
    throw new Error("The GitHub App private key must be PKCS#8. Convert it with openssl pkcs8 -topk8 -nocrypt.");
  }
  const body = trimmed.slice(PKCS8_HEADER.length, -PKCS8_FOOTER.length).replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function encodeJson(value: Record<string, string | number>): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
