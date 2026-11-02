import { describe, expect, it } from "vitest";
import { scanAddedLines } from "./secrets.js";

// The samples are assembled at runtime so the source file itself holds no credential-shaped string.
const SAMPLES = {
  "private key": ["-----BEGIN ", "RSA PRIVATE KEY-----"].join(""),
  "AWS access key id": ["AKIA", "Q3EXAMPLEKEY2ZXW"].join(""),
  "GitHub token": ["gh", "p_", "a1B2c3D4".repeat(5)].join(""),
  "Anthropic API key": ["sk-", "ant-", "api03-", "Zx9".repeat(10)].join(""),
  "Slack token": ["xo", "xb-", "1234567890-abcdefghij"].join(""),
  "credential assignment": ["const dbPass", 'word = "', "k".repeat(6), "9".repeat(8), '";'].join(""),
};

describe("scanAddedLines", () => {
  it("names each kind with its file and new line number", () => {
    const added = Object.values(SAMPLES).map((sample) => `+${sample}`);
    const patch = [
      "diff --git a/src/config.ts b/src/config.ts",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -4,3 +4,9 @@ export const config = {",
      " export const name = 1;",
      ...added,
      "-const removed = 1;",
      " export const end = 1;",
    ].join("\n");

    expect(scanAddedLines(patch)).toEqual(
      Object.keys(SAMPLES).map((kind, index) => ({ path: "src/config.ts", line: 5 + index, kind })),
    );
  });

  it("never returns the matched text", () => {
    const patch = ["--- /dev/null", "+++ b/src/client.ts", "@@ -0,0 +1 @@", `+export const key = "${SAMPLES["GitHub token"]}";`].join(
      "\n",
    );
    const findings = scanAddedLines(patch);
    expect(findings).toEqual([{ path: "src/client.ts", line: 1, kind: "GitHub token" }]);
    expect(JSON.stringify(findings)).not.toContain(SAMPLES["GitHub token"].slice(4));
  });

  it("ignores removed and unchanged lines and ordinary code", () => {
    const patch = [
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1,3 +1,3 @@",
      ` const old = "${SAMPLES["AWS access key id"]}";`,
      `-const token = "${SAMPLES["Slack token"]}";`,
      "+const token = readToken(process.env);",
      '+const passwordLabel = "Password";',
    ].join("\n");
    expect(scanAddedLines(patch)).toEqual([]);
  });
});
