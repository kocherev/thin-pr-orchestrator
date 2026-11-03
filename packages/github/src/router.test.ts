import { describe, expect, it } from "vitest";
import { parseCommand, routeEvent } from "./router.js";

const repository = { name: "sample-repo", default_branch: "main", owner: { login: "example" } };
const human = { login: "octocat", type: "User" };
const REPO = { owner: "example", name: "sample-repo", defaultBranch: "main" };

function labeled(label: string, sender = human) {
  return { action: "labeled", label: { name: label }, issue: { number: 7, title: "Add a flag", body: null }, repository, sender };
}

function comment(body: string, options: { readonly association?: string; readonly user?: typeof human; readonly pull?: boolean } = {}) {
  const user = options.user ?? human;
  return {
    action: "created",
    issue: {
      number: 7,
      title: "Add a flag",
      body: "Add a --verbose flag.",
      labels: [{ name: "bug" }, { name: "thin-pr:bugfix" }],
      ...(options.pull && { pull_request: { url: "https://api.github.com/repos/example/sample-repo/pulls/7" } }),
    },
    comment: { id: 55, body, user, author_association: options.association ?? "MEMBER" },
    repository,
    sender: user,
    installation: { id: 42 },
  };
}

describe("routeEvent", () => {
  it("routes any thin-pr label to a label run", () => {
    for (const label of ["thin-pr", "thin-pr:docs", "thin-pr:bugfix"]) {
      expect(routeEvent("issues", labeled(label))).toEqual({
        kind: "run",
        installationId: null,
        trigger: { kind: "label", repo: REPO, issue: { number: 7, title: "Add a flag", body: "" }, label },
      });
    }
    expect(routeEvent("issues", labeled("bug"))).toEqual({ kind: "ignored", reason: "label bug is not a thin-pr label" });
    expect(routeEvent("issues", { ...labeled("thin-pr"), action: "unlabeled" }).kind).toBe("ignored");
  });

  it("routes a command from a user with write access, with the issue's labels", () => {
    expect(routeEvent("issue_comment", comment("/thin-pr approve\nplease"))).toEqual({
      kind: "run",
      installationId: 42,
      trigger: {
        kind: "command",
        repo: REPO,
        issue: { number: 7, title: "Add a flag", body: "Add a --verbose flag.", labels: ["bug", "thin-pr:bugfix"], pull: false },
        command: "approve",
        comment: { id: 55, author: "octocat" },
      },
    });
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(routeEvent("issue_comment", comment("/thin-pr retry", { association })).kind).toBe("run");
    }
    const onPull = routeEvent("issue_comment", comment("/thin-pr cancel", { pull: true }));
    expect(onPull.kind === "run" && onPull.trigger.kind === "command" && onPull.trigger.issue.pull).toBe(true);
  });

  it("ignores, and does not answer, commands from users without write access", () => {
    for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"]) {
      expect(routeEvent("issue_comment", comment("/thin-pr approve", { association }))).toEqual({
        kind: "ignored",
        reason: `octocat is ${association}, not a user with write access`,
      });
    }
  });

  it("ignores every event a bot sends, including its own comments that quote a command", () => {
    const bot = { login: "thin-pr[bot]", type: "Bot" };
    expect(routeEvent("issue_comment", comment("/thin-pr approve", { user: bot, association: "NONE" }))).toEqual({
      kind: "ignored",
      reason: "sent by the bot thin-pr[bot]",
    });
    expect(routeEvent("issues", labeled("thin-pr", bot)).kind).toBe("ignored");
    // A human can send an event about a bot's comment only by editing it, which is not `created`. The comment's own
    // author is checked too.
    const byBot = { ...comment("/thin-pr approve", { user: bot }), sender: human };
    expect(routeEvent("issue_comment", byBot)).toEqual({ kind: "ignored", reason: "written by the bot thin-pr[bot]" });
  });

  it("ignores comments that are not commands, and events that start nothing", () => {
    expect(routeEvent("issue_comment", comment("Looks good. To open it, comment `/thin-pr approve`.")).kind).toBe("ignored");
    expect(routeEvent("issue_comment", { ...comment("/thin-pr approve"), action: "edited" }).kind).toBe("ignored");
    expect(routeEvent("push", { sender: human })).toEqual({ kind: "ignored", reason: "push does not start a run" });
    expect(routeEvent("ping", { zen: "Keep it logically awesome." }).kind).toBe("ignored");
  });

  it("reports a payload that does not parse", () => {
    expect(routeEvent("issues", null).kind).toBe("invalid");
    expect(routeEvent("issue_comment", { ...comment("/thin-pr approve"), comment: { id: "55" } })).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/^comment\./),
    });
    expect(routeEvent("issues", { ...labeled("thin-pr"), repository: { ...repository, name: "a/../b" } })).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/^repo\.name/),
    });
  });
});

describe("parseCommand", () => {
  it("reads the first line, and answers an unknown word with help", () => {
    expect(parseCommand("/thin-pr approve")).toBe("approve");
    expect(parseCommand("  /thin-pr RETRY now")).toBe("retry");
    expect(parseCommand("/thin-pr cancel\nthanks")).toBe("cancel");
    expect(parseCommand("/thin-pr")).toBe("help");
    expect(parseCommand("/thin-pr merge")).toBe("help");
    expect(parseCommand("please /thin-pr approve")).toBeNull();
    expect(parseCommand("/thin-pragmatic")).toBeNull();
  });
});
