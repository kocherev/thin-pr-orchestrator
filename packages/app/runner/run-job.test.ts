import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spanNames } from "@thin-pr/github";
import { createScratchRepo } from "@thin-pr/workspace";
import type { Job } from "../src/event.js";
import { runJob } from "./run-job.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const cleanups: (() => void)[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const DELIVERY = "72d3162e-cc78-11e3-81ab-4c9367dc0958";

// The issue in fixtures/sample-issue-labeled.json, as the Worker queues it.
const JOB: Job = {
  deliveryId: DELIVERY,
  key: DELIVERY,
  installationId: 42,
  trigger: {
    kind: "label",
    repo: { owner: "example", name: "sample-repo", defaultBranch: "main" },
    issue: { number: 7, title: "Sample thin pull request", body: "Run the feature template on this issue." },
    label: "thin-pr",
  },
};

type ApiCall = { readonly method: string; readonly path: string; readonly authorization: string; readonly body: string };

// Answers the GitHub REST calls a run makes (check runs, pull requests, comments) and records OTLP exports too.
async function fakeGitHub(): Promise<{ readonly url: string; readonly calls: ApiCall[] }> {
  const calls: ApiCall[] = [];
  const server: Server = createServer(async (request, response) => {
    calls.push({
      method: request.method ?? "",
      path: (request.url ?? "").split("?")[0] ?? "",
      authorization: request.headers.authorization ?? "",
      body: await text(request),
    });
    const body =
      request.method === "GET"
        ? []
        : { id: calls.length, number: 11, html_url: "https://github.com/example/sample-repo/pull/11", user: { login: "thin-pr[bot]" } };
    response.writeHead(request.method === "POST" ? 201 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return { url: `http://127.0.0.1:${address.port}`, calls };
}

// A scratch remote that stands in for github.com/example/sample-repo, and a fake GitHub API.
async function sampleRepo() {
  const repo = createScratchRepo({
    "src/stub.ts": "export function stub(): number {\n  return 0;\n}\n",
    ".thin-pr.yml": "checks:\n  typecheck: echo typecheck ok\n  test: echo test ok\n",
  });
  cleanups.push(() => repo.remove());
  const home = mkdtempSync(join(tmpdir(), "thin-pr-home-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  // Global git config stands in for github.com: the clone and the push reach the scratch remote instead.
  const gitconfig = join(home, ".gitconfig");
  writeFileSync(
    gitconfig,
    `[url "${repo.remote}"]\n\tinsteadOf = https://github.com/example/sample-repo.git\n` +
      "[user]\n\tname = thin-pr\n\temail = thin-pr@localhost\n[commit]\n\tgpgsign = false\n",
  );
  vi.stubEnv("GIT_CONFIG_GLOBAL", gitconfig);
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
  const github = await fakeGitHub();
  const env = {
    GITHUB_TOKEN: "ghs_test",
    GITHUB_APP_SLUG: "thin-pr-test",
    GITHUB_API_URL: github.url,
    THIN_PR_MODEL: "replay",
    THIN_PR_CASSETTE: join(root, "fixtures", "gate-pass.jsonl"),
  };
  return { repo, github, env };
}

describe("runJob", () => {
  it("clones the default branch, runs the issue as the Action does, and pushes the draft branch", async () => {
    const { repo, github, env } = await sampleRepo();

    const record = await runJob(JOB, { ...process.env, ...env });

    expect(record).toMatchObject({
      runId: `app-${JOB.deliveryId}`,
      status: "opened",
      pullRequest: { number: 11, url: "https://github.com/example/sample-repo/pull/11" },
    });
    const pushed = execFileSync("git", ["show", "thin-pr/7:src/stub.ts"], { cwd: repo.remote, encoding: "utf8" });
    expect(pushed).toContain("return 1;");
    const draft = github.calls.find((call) => call.method === "POST" && call.path === "/repos/example/sample-repo/pulls");
    expect(draft?.authorization).toBe("token ghs_test");
    expect(JSON.parse(draft?.body ?? "{}")).toMatchObject({ head: "thin-pr/7", base: "main", draft: true });
    expect(github.calls.some((call) => call.path === "/v1/traces")).toBe(false);
  });

  it("flushes the run's trace to the OTLP endpoint when one is set", async () => {
    const { github, env } = await sampleRepo();
    // The OpenTelemetry SDK reads the exporter settings from process.env.
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", github.url);
    vi.stubEnv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");

    const record = await runJob(JOB, { ...process.env, ...env });

    expect(record?.status).toBe("opened");
    const exports = github.calls.filter((call) => call.method === "POST" && call.path === "/v1/traces");
    const names = exports.flatMap((call) => spanNames(JSON.parse(call.body) as unknown));
    expect(names).toContain("thin-pr.run");
    expect(names).toContain("thin-pr.implement");
  });

  it("runs a command job and reports its outcome when it starts no run", async () => {
    const { github, env } = await sampleRepo();
    const job: Job = {
      ...JOB,
      trigger: {
        kind: "command",
        repo: JOB.trigger.repo,
        issue: { number: 7, title: "Sample thin pull request", body: "", labels: ["thin-pr"], pull: false },
        command: "approve",
        comment: { id: 55, author: "octocat" },
      },
    };

    await expect(runJob(job, { ...process.env, ...env })).resolves.toEqual({
      deliveryId: JOB.deliveryId,
      trigger: "command",
      status: "refused",
    });
    const reactions = github.calls.filter((call) => call.path === "/repos/example/sample-repo/issues/comments/55/reactions");
    expect(reactions.map((call) => JSON.parse(call.body).content)).toEqual(["eyes", "confused"]);
    const reply = github.calls.find((call) => call.method === "POST" && call.path === "/repos/example/sample-repo/issues/7/comments");
    expect(JSON.parse(reply?.body ?? "{}").body).toBe("No run on #7 waits for approval.");
  });

  it("refuses to start without an installation token", async () => {
    await expect(runJob(JOB, { ...process.env, GITHUB_TOKEN: "" })).rejects.toThrow("GITHUB_TOKEN is missing");
  });

  it("refuses to start without the App's slug, which names its own comments", async () => {
    await expect(runJob(JOB, { ...process.env, GITHUB_TOKEN: "ghs_test", GITHUB_APP_SLUG: "" })).rejects.toThrow(
      "GITHUB_APP_SLUG is missing",
    );
  });
});
