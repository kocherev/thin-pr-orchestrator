import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";
import { z } from "zod";
import { actionWorkflowEnabled } from "./action-workflow.js";
import { readDelivery, type Job } from "./event.js";
import { createInstallationToken } from "./installation-token.js";
import { runnerAllowedHosts, runnerEnvVars } from "./runner-config.js";
import { verifySignature } from "./signature.js";

// The Container class routes allowedHosts through this entrypoint.
export { ContainerProxy };

declare global {
  interface Env {
    /** Optional secret. It is not in `secrets.required`, so `wrangler types` does not generate it. */
    readonly OTEL_EXPORTER_OTLP_HEADERS?: string;
  }
}

const runStatusSchema = z.object({ running: z.boolean() });

/**
 * Called when `sleepAfter` passes without a request. The run outlives the POST that started it, so the container
 * stops only once its server reports no run in progress. Returning without stopping renews the timer.
 */
export async function stopWhenIdle(runner: {
  containerFetch(url: string): Promise<Response>;
  stop(): Promise<void>;
}): Promise<void> {
  let running = false;
  try {
    const response = await runner.containerFetch("http://runner/status");
    running = runStatusSchema.parse(await response.json()).running;
  } catch (error) {
    console.error("runner status check failed, stopping the container", error);
  }
  if (!running) {
    await runner.stop();
  }
}

export class Runner extends Container {
  defaultPort = 8080;
  sleepAfter = "15m";
  enableInternet = false;
  // HTTPS has to pass through ContainerProxy for allowedHosts to see the hostname.
  interceptHttps = true;
  allowedHosts: string[];

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.allowedHosts = runnerAllowedHosts(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  }

  override async onActivityExpired(): Promise<void> {
    await stopWhenIdle(this);
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    const body = await request.arrayBuffer();
    const signature = request.headers.get("x-hub-signature-256");
    if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, signature))) {
      return new Response("bad signature", { status: 401 });
    }
    const delivery = readDelivery(request.headers, new TextDecoder().decode(body));
    switch (delivery.kind) {
      case "ignored":
        return new Response(null, { status: 204 });
      case "invalid":
        return new Response(delivery.reason, { status: 400 });
      case "job":
        await env.JOBS.send(delivery.job);
        return new Response(null, { status: 202 });
      default: {
        const unhandled: never = delivery;
        return unhandled;
      }
    }
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const job = message.body;
      try {
        const outcome = await dispatch(job, env);
        console.log(`delivery ${job.deliveryId} for ${job.owner}/${job.repo}#${job.issueNumber}: ${outcome}`);
        message.ack();
      } catch (error) {
        console.error(`dispatch failed for delivery ${job.deliveryId}`, error);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, Job>;

async function dispatch(job: Job, env: Env): Promise<"started" | "left to the Action"> {
  const fetcher = fetch.bind(globalThis);
  const installation = await createInstallationToken({
    app: { clientId: env.GITHUB_APP_CLIENT_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY },
    installationId: job.installationId,
    repository: job.repo,
    fetch: fetcher,
  });
  if (await actionWorkflowEnabled({ owner: job.owner, repo: job.repo, token: installation.token, fetch: fetcher })) {
    return "left to the Action";
  }
  const runner = getContainer(env.RUNNER, job.deliveryId);
  await runner.start({ envVars: runnerEnvVars(env, installation.token) });
  const response = await runner.fetch("http://runner/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(job),
  });
  await response.body?.cancel();
  if (response.status !== 202) {
    throw new Error(`runner answered ${response.status}`);
  }
  return "started";
}
