import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { firstIssue, jobSchema, type Job } from "../src/event.js";

/**
 * `POST /run` validates a job, answers 202, and runs it in the background. `GET /status` reports whether a run is
 * still going, so the Worker keeps the container alive until it ends.
 */
export function createRunnerServer(run: (job: Job) => Promise<void>): Server {
  // A queue retry, or another event for the same review, can bring a key this instance already accepted. It must
  // not start twice.
  const accepted = new Set<string>();
  let running = 0;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === "/status") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ running: running > 0 }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/run") {
      response.writeHead(404).end();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await text(request));
    } catch {
      response.writeHead(400).end("body is not JSON");
      return;
    }
    const job = jobSchema.safeParse(body);
    if (!job.success) {
      response.writeHead(400).end(firstIssue(job.error));
      return;
    }
    const { deliveryId, key } = job.data;
    response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ deliveryId }));
    if (accepted.has(key)) {
      return;
    }
    accepted.add(key);
    running += 1;
    console.log(`accepted delivery ${deliveryId}`);
    run(job.data)
      .catch((error: unknown) => {
        console.error(`delivery ${deliveryId} failed:`, error instanceof Error ? error.message : error);
      })
      .finally(() => {
        running -= 1;
      });
  }

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      console.error("request failed:", error);
      if (!response.headersSent) {
        response.writeHead(500).end();
      }
    });
  });
}
