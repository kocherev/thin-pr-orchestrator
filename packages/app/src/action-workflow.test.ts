import { describe, expect, it } from "vitest";
import { actionWorkflowEnabled } from "./action-workflow.js";

function answer(status: number, body: unknown) {
  const requests: { readonly url: string; readonly authorization: string | null }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push({ url: request.url, authorization: request.headers.get("authorization") });
    return Response.json(body, { status });
  };
  return { requests, check: () => actionWorkflowEnabled({ owner: "example", repo: "sample-repo", token: "ghs_test", fetch }) };
}

describe("actionWorkflowEnabled", () => {
  it("asks for the thin-pr workflow with the installation token", async () => {
    const github = answer(200, { state: "active" });
    expect(await github.check()).toBe(true);
    expect(github.requests).toEqual([
      {
        url: "https://api.github.com/repos/example/sample-repo/actions/workflows/thin-pr.yml",
        authorization: "Bearer ghs_test",
      },
    ]);
  });

  it("hands the repository to the App when the workflow is missing or disabled", async () => {
    expect(await answer(404, { message: "Not Found" }).check()).toBe(false);
    expect(await answer(200, { state: "disabled_manually" }).check()).toBe(false);
  });

  it("fails when GitHub cannot say", async () => {
    await expect(answer(502, { message: "Bad gateway" }).check()).rejects.toThrow(
      'GitHub returned 502 for thin-pr.yml in example/sample-repo: {"message":"Bad gateway"}',
    );
  });
});
