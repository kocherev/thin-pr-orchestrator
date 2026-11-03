import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readLabelEvent } from "./event.js";

const payload = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../fixtures/sample-issue-labeled.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

describe("readLabelEvent", () => {
  it("reads the fields a run needs from a labeled issue payload", () => {
    expect(readLabelEvent(payload)).toEqual({
      action: "labeled",
      label: "thin-pr",
      owner: "example",
      repo: "sample-repo",
      defaultBranch: "main",
      issue: {
        number: 7,
        title: "Sample thin pull request",
        body: "Run the feature template on this issue.",
        url: "https://github.com/example/sample-repo/issues/7",
      },
      issueText: "#7 Sample thin pull request\n\nRun the feature template on this issue.",
    });
  });

  it("treats a null body as empty", () => {
    const event = readLabelEvent(withIssue({ number: 7, title: "Sample thin pull request", body: null }));
    expect(event.issueText).toBe("#7 Sample thin pull request");
  });

  it("rejects a bad payload with the path of the first problem", () => {
    expect(() => readLabelEvent(withIssue({ number: "7", title: "Sample", body: null }))).toThrow(
      "event payload invalid at issue.number: Invalid input: expected number, received string",
    );
    expect(() => readLabelEvent(withIssue({ number: 0, title: "Sample", body: null }))).toThrow(
      "event payload invalid at issue.number",
    );
    expect(() => readLabelEvent({ action: "labeled" })).toThrow("event payload invalid at label");
    expect(() => readLabelEvent(null)).toThrow("event payload invalid at (root)");
  });
});

function withIssue(issue: unknown): unknown {
  return { ...payload, issue };
}
