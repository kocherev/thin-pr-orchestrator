export type SecretFinding = { readonly path: string; readonly line: number; readonly kind: string };

const PATTERNS: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "GitHub token", pattern: /\b(?:gh[pos]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { kind: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  // A real value mixes letters and digits. Words alone, such as a test's "internal-secret", are placeholders.
  { kind: "credential assignment", pattern: /(?:password|secret|token)\s*[:=]\s*['"](?=[^'"]*[a-z])(?=[^'"]*\d)[^'"]{12,}/i },
];

/**
 * Finds credential-shaped text on the lines a unified diff adds. A finding names the file, the line in the new
 * file, and the kind of secret. It never carries the matched text.
 */
export function scanAddedLines(patch: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let path = "";
  let line = 0;
  let previous = "";
  for (const text of patch.split("\n")) {
    const header = text.startsWith("+++ ") && previous.startsWith("--- ");
    previous = text;
    if (header) {
      path = text.slice(4).replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (text.startsWith("+")) {
      for (const { kind, pattern } of PATTERNS) {
        if (pattern.test(text)) {
          findings.push({ path, line, kind });
        }
      }
      line += 1;
    } else if (text.startsWith(" ")) {
      line += 1;
    }
  }
  return findings;
}
