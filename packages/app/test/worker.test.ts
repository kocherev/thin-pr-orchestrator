import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../src/event.js";
import { stopWhenIdle } from "../src/worker.js";
import worker, { runner } from "./main.js";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DELIVERY_ID = "72d3162e-cc78-11e3-81ab-4c9367dc0958";

const JOB: Job = {
  deliveryId: DELIVERY_ID,
  key: DELIVERY_ID,
  installationId: 42,
  trigger: {
    kind: "label",
    repo: { owner: "example", name: "sample-repo", defaultBranch: "main" },
    issue: { number: 7, title: "Add a flag", body: "Add a --verbose flag." },
    label: "thin-pr",
  },
};

const LABELED = JSON.stringify({
  action: "labeled",
  label: { name: "thin-pr" },
  issue: { number: 7, title: "Add a flag", body: "Add a --verbose flag." },
  repository: { name: "sample-repo", default_branch: "main", owner: { login: "example" } },
  installation: { id: 42 },
});

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function deliver(event: string, body: string, signature?: string): Promise<Response> {
  const request = new IncomingRequest("https://app.example/", {
    method: "POST",
    headers: {
      "x-github-event": event,
      "x-github-delivery": DELIVERY_ID,
      "x-hub-signature-256": signature ?? (await sign(body)),
    },
    body,
  });
  return worker.fetch(request, env);
}

async function consume(job: Job): Promise<{ readonly acked: boolean; readonly retried: boolean }> {
  const batch = createMessageBatch<Job>("pr-jobs", [{ id: "message-1", timestamp: new Date(), attempts: 1, body: job }]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  const result = await getQueueResult(batch, ctx);
  return {
    acked: result.explicitAcks.includes("message-1"),
    retried: result.retryMessages.some((message) => message.msgId === "message-1"),
  };
}

const WORKFLOW_URL = "https://api.github.com/repos/example/sample-repo/actions/workflows/thin-pr.yml";

const githubRequests: { readonly url: string; readonly body: string }[] = [];
let workflow: Response | null = null;

beforeEach(() => {
  runner.status = 202;
  runner.starts.length = 0;
  runner.runs.length = 0;
  githubRequests.length = 0;
  workflow = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    githubRequests.push({ url: request.url, body: await request.text() });
    if (request.url === "https://api.github.com/app/installations/42/access_tokens") {
      return Response.json({ token: "ghs_test", expires_at: "2026-11-02T13:00:00Z" }, { status: 201 });
    }
    if (request.url === WORKFLOW_URL) {
      return workflow ?? Response.json({ message: "Not Found" }, { status: 404 });
    }
    return new Response("unexpected request", { status: 500 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("webhook intake", () => {
  it("queues a thin-pr label and hands the job to a runner named after the delivery", async () => {
    const response = await deliver("issues", LABELED);
    expect(response.status).toBe(202);

    await vi.waitFor(() => expect(runner.runs).toHaveLength(1), { timeout: 5000 });
    expect(runner.runs[0]).toEqual({ name: DELIVERY_ID, url: "http://runner/run", job: JOB });
    expect(runner.starts).toEqual([
      {
        name: DELIVERY_ID,
        envVars: {
          GITHUB_TOKEN: "ghs_test",
          ANTHROPIC_API_KEY: "test-anthropic-key",
          THIN_PR_MODEL: "live",
          THIN_PR_SPEND_LIMIT_USD: "25",
          GITHUB_APP_SLUG: "thin-pr-test",
        },
      },
    ]);
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/app/installations/42/access_tokens",
        body: JSON.stringify({ repositories: ["sample-repo"] }),
      },
      { url: WORKFLOW_URL, body: "" },
    ]);
  });

  it("rejects a delivery whose signature does not match", async () => {
    const response = await deliver("issues", LABELED, await sign(`${LABELED} `));
    expect(response.status).toBe(401);
  });

  it("answers 204 to events that do not start a run", async () => {
    expect((await deliver("ping", JSON.stringify({ zen: "Keep it logically awesome." }))).status).toBe(204);
    expect((await deliver("issues", LABELED.replace('"thin-pr"', '"bug"'))).status).toBe(204);
  });

  it("queues a command from a collaborator and ignores the same command from a bot", async () => {
    const command = (user: { login: string; type: string }) =>
      JSON.stringify({
        action: "created",
        issue: { number: 7, title: "Add a flag", body: null, labels: [{ name: "thin-pr" }] },
        comment: { id: 55, body: "/thin-pr approve", user, author_association: "MEMBER" },
        repository: { name: "sample-repo", default_branch: "main", owner: { login: "example" } },
        sender: user,
        installation: { id: 42 },
      });
    expect((await deliver("issue_comment", command({ login: "octocat", type: "User" }))).status).toBe(202);
    expect((await deliver("issue_comment", command({ login: "thin-pr[bot]", type: "Bot" }))).status).toBe(204);
  });

  it("accepts only POST", async () => {
    const response = await worker.fetch(new IncomingRequest("https://app.example/"), env);
    expect(response.status).toBe(405);
  });
});

describe("job consumer", () => {
  it("acks the message once the runner accepts the job", async () => {
    expect(await consume(JOB)).toEqual({ acked: true, retried: false });
  });

  it("retries the message when the runner refuses the job", async () => {
    runner.status = 503;
    expect(await consume(JOB)).toEqual({ acked: false, retried: true });
  });

  it("retries the message when GitHub refuses the installation token", async () => {
    expect(await consume({ ...JOB, installationId: 7 })).toEqual({ acked: false, retried: true });
    expect(runner.starts).toHaveLength(0);
  });

  it("leaves the label to the Action while the thin-pr workflow is enabled", async () => {
    workflow = Response.json({ state: "active" });
    expect(await consume(JOB)).toEqual({ acked: true, retried: false });
    expect(runner.starts).toHaveLength(0);
  });

  it("runs when the thin-pr workflow is disabled", async () => {
    workflow = Response.json({ state: "disabled_manually" });
    expect(await consume(JOB)).toEqual({ acked: true, retried: false });
    expect(runner.runs).toHaveLength(1);
  });
});

describe("container lifetime", () => {
  function container(status: () => Promise<Response>) {
    const calls: string[] = [];
    return {
      calls,
      async containerFetch(url: string) {
        calls.push(url);
        return status();
      },
      async stop() {
        calls.push("stop");
      },
    };
  }

  it("keeps the container while a run is in progress", async () => {
    const busy = container(async () => Response.json({ running: true }));
    await stopWhenIdle(busy);
    expect(busy.calls).toEqual(["http://runner/status"]);
  });

  it("stops the container once the run ended", async () => {
    const idle = container(async () => Response.json({ running: false }));
    await stopWhenIdle(idle);
    expect(idle.calls).toEqual(["http://runner/status", "stop"]);
  });

  it("stops a container whose server does not answer", async () => {
    const gone = container(async () => {
      throw new Error("connection refused");
    });
    await stopWhenIdle(gone);
    expect(gone.calls).toEqual(["http://runner/status", "stop"]);
  });
});
