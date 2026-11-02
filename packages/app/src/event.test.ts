import { describe, expect, it } from "vitest";
import { readDelivery } from "./event.js";

const DELIVERY_ID = "72d3162e-cc78-11e3-81ab-4c9367dc0958";

function headers(event: string): Headers {
  return new Headers({ "x-github-event": event, "x-github-delivery": DELIVERY_ID });
}

function labeled(label: string): Record<string, unknown> {
  return {
    action: "labeled",
    label: { name: label },
    issue: { number: 7, title: "Add a flag", body: null },
    repository: { name: "sample-repo", default_branch: "main", owner: { login: "example" } },
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
        owner: "example",
        repo: "sample-repo",
        defaultBranch: "main",
        issueNumber: 7,
        issueTitle: "Add a flag",
        issueBody: "",
        label: "thin-pr",
      },
    });
  });

  it("keeps the template named in the label", () => {
    const delivery = readDelivery(headers("issues"), JSON.stringify(labeled("thin-pr:bug-fix")));
    expect(delivery.kind === "job" && delivery.job.label).toBe("thin-pr:bug-fix");
  });

  it("ignores other events, actions, and labels", () => {
    const body = JSON.stringify(labeled("thin-pr"));
    expect(readDelivery(headers("ping"), body)).toEqual({ kind: "ignored" });
    expect(readDelivery(headers("issues"), JSON.stringify({ ...labeled("thin-pr"), action: "unlabeled" }))).toEqual({
      kind: "ignored",
    });
    for (const label of ["bug", "thin-pr-later", "thin-pr:", "thin-pr:Bug Fix"]) {
      expect(readDelivery(headers("issues"), JSON.stringify(labeled(label)))).toEqual({ kind: "ignored" });
    }
  });

  it("rejects a trigger without an installation", () => {
    const payload = labeled("thin-pr");
    delete payload.installation;
    expect(readDelivery(headers("issues"), JSON.stringify(payload))).toEqual({
      kind: "invalid",
      reason: "installation: Invalid input: expected object, received undefined",
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
