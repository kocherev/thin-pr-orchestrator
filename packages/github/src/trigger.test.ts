import { describe, expect, it } from "vitest";
import type { RunRecord } from "./record.js";
import type { Trigger } from "./router.js";
import type { StoredRun } from "./approval.js";
import { pushedBranch, type TriggerOutcome } from "./trigger.js";

const REPO = { owner: "example", name: "sample-repo", defaultBranch: "main" };
const LABEL: Trigger = { kind: "label", repo: REPO, issue: { number: 7, title: "Fix it", body: "" }, label: "thin-pr" };
const REVISE: Trigger = { kind: "revise", repo: REPO, pull: { number: 12, branch: "thin-pr/7", issue: 7 }, reviewId: 501, reviewer: "octocat" };
// Only the fields pushedBranch reads.
const record = { issue: { number: 7 } } as RunRecord;

describe("pushedBranch", () => {
  it("names the branch a run pushed, so the Action can start the repo's CI on it", () => {
    const stored = { branch: { name: "thin-pr/7", head: "abc", base: "main" } } as StoredRun;
    const label = (result: Extract<TriggerOutcome, { kind: "label" }>["result"]): TriggerOutcome => ({ kind: "label", result });

    expect(pushedBranch(LABEL, label({ status: "opened", record }))).toBe("thin-pr/7");
    expect(pushedBranch(LABEL, label({ status: "awaiting_approval", record, stored }))).toBe("thin-pr/7");
    expect(pushedBranch(REVISE, { kind: "revise", result: { status: "pushed", record, head: "def" } })).toBe("thin-pr/7");
  });

  it("names none when nothing was pushed", () => {
    expect(pushedBranch(LABEL, { kind: "label", result: { status: "blocked", record, error: "gate failed: tests" } })).toBeNull();
    expect(pushedBranch(LABEL, { kind: "label", result: { status: "ignored" } })).toBeNull();
    expect(pushedBranch(REVISE, { kind: "revise", result: { status: "ignored", reason: "already answered" } })).toBeNull();
  });
});
