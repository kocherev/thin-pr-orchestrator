import { afterEach, describe, expect, it } from "vitest";
import type { Job } from "../src/event.js";
import { createRunnerServer } from "./server.js";

const JOB: Job = {
  deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  installationId: 42,
  trigger: {
    kind: "label",
    repo: { owner: "example", name: "sample-repo", defaultBranch: "main" },
    issue: { number: 7, title: "Add a flag", body: "" },
    label: "thin-pr",
  },
};

const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) {
    close();
  }
});

async function start(run: (job: Job) => Promise<void>): Promise<string> {
  const server = createRunnerServer(run);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function status(base: string): Promise<unknown> {
  return (await fetch(`${base}/status`)).json();
}

function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/run`, { method: "POST", body: JSON.stringify(body) });
}

describe("runner server", () => {
  it("answers 202 at once and reports the run until it ends", async () => {
    let finish = () => {};
    const started: Job[] = [];
    const base = await start(async (job) => {
      started.push(job);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });

    expect(await status(base)).toEqual({ running: false });
    const response = await post(base, JOB);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ deliveryId: JOB.deliveryId });
    expect(started).toEqual([JOB]);
    expect(await status(base)).toEqual({ running: true });

    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await status(base)).toEqual({ running: false });
  });

  it("does not start a delivery twice", async () => {
    const started: Job[] = [];
    const base = await start(async (job) => {
      started.push(job);
    });
    expect((await post(base, JOB)).status).toBe(202);
    expect((await post(base, JOB)).status).toBe(202);
    expect(started).toHaveLength(1);
  });

  it("reports a failed run as finished", async () => {
    const base = await start(async () => {
      throw new Error("clone failed");
    });
    await post(base, JOB);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await status(base)).toEqual({ running: false });
  });

  it("rejects a job that does not parse", async () => {
    const base = await start(async () => {});
    const response = await post(base, { ...JOB, trigger: { ...JOB.trigger, repo: { ...JOB.trigger.repo, owner: "../etc" } } });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("trigger.repo.owner: Invalid string: must match pattern /^[A-Za-z0-9_.-]+$/");
  });
});
