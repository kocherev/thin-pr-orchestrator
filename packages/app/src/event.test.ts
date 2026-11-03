import { describe, expect, it } from "vitest";
import { readDelivery } from "./event.js";

const DELIVERY_ID = "72d3162e-cc78-11e3-81ab-4c9367dc0958";

function headers(event: string): Headers {
  return new Headers({ "x-github-event": event, "x-github-delivery": DELIVERY_ID });
}

const repository = { name: "sample-repo", default_branch: "main", owner: { login: "example" } };

function labeled(label: string): Record<string, unknown> {
  return {
    action: "labeled",
    label: { name: label },
    issue: { number: 7, title: "Add a flag", body: null },
    repository,
    sender: { login: "octocat", type: "User" },
    installation: { id: 42 },
  };
}

describe("readDelivery", () => {
  it("turns a thin-pr label into a job", () => {
    expect(readDelivery(headers("issues"), JSON.stringify(labeled("thin-pr")))).toEqual({
      kind: "job",
      job: {
        deliveryId: DELIVERY_ID,
        installationId: 42,
        trigger: {
          kind: "label",
          repo: { owner: "example", name: "sample-repo", defaultBranch: "main" },
          issue: { number: 7, title: "Add a flag", body: "" },
          label: "thin-pr",
        },
      },
    });
  });

  it("keeps the template named in the label", () => {
    const delivery = readDelivery(headers("issues"), JSON.stringify(labeled("thin-pr:bug-fix")));
    expect(delivery.kind === "job" && delivery.job.trigger.kind === "label" && delivery.job.trigger.label).toBe("thin-pr:bug-fix");
  });

  it("turns a command from a collaborator into a job, through the same router as the Action", () => {
    const payload = {
      action: "created",
      issue: { number: 7, title: "Add a flag", body: null, labels: [{ name: "thin-pr" }] },
      comment: { id: 55, body: "/thin-pr retry", user: { login: "octocat", type: "User" }, author_association: "COLLABORATOR" },
      repository,
      sender: { login: "octocat", type: "User" },
      installation: { id: 42 },
    };
    const delivery = readDelivery(headers("issue_comment"), JSON.stringify(payload));
    expect(delivery.kind === "job" && delivery.job.trigger).toMatchObject({ kind: "command", command: "retry", comment: { id: 55 } });
  });

  it("ignores other events, actions, and labels", () => {
    const body = JSON.stringify(labeled("thin-pr"));
    expect(readDelivery(headers("ping"), body).kind).toBe("ignored");
    expect(readDelivery(headers("issues"), JSON.stringify({ ...labeled("thin-pr"), action: "unlabeled" })).kind).toBe("ignored");
    for (const label of ["bug", "thin-pr-later", "thin-pr:", "thin-pr:Bug Fix"]) {
      expect(readDelivery(headers("issues"), JSON.stringify(labeled(label))).kind).toBe("ignored");
    }
  });

  it("rejects a trigger without an installation", () => {
    const payload = labeled("thin-pr");
    delete payload.installation;
    expect(readDelivery(headers("issues"), JSON.stringify(payload))).toEqual({
      kind: "invalid",
      reason: "installationId: Invalid input: expected number, received null",
    });
  });

  it("rejects a repository name that cannot be part of a clone URL", () => {
    const payload = labeled("thin-pr");
    payload.repository = { name: "repo/../../etc", default_branch: "main", owner: { login: "example" } };
    expect(readDelivery(headers("issues"), JSON.stringify(payload)).kind).toBe("invalid");
  });

  it("rejects a body that is not JSON", () => {
    expect(readDelivery(headers("issues"), "{")).toEqual({ kind: "invalid", reason: "body is not JSON" });
  });
});
