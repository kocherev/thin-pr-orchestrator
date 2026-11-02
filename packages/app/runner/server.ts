import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { firstIssue, jobSchema } from "../src/event.js";
import { runJob } from "./run-job.js";

const PORT = 8080;

// A queue retry can deliver a job this instance already accepted. It must not start twice.
const accepted = new Set<string>();

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
  const deliveryId = job.data.deliveryId;
  response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ deliveryId }));
  if (accepted.has(deliveryId)) {
    return;
  }
  accepted.add(deliveryId);
  console.log(`accepted delivery ${deliveryId}`);
  runJob(job.data, process.env).catch((error: unknown) => {
    console.error(`delivery ${deliveryId} failed:`, error instanceof Error ? error.message : error);
  });
}

createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    console.error("request failed:", error);
    if (!response.headersSent) {
      response.writeHead(500).end();
    }
  });
}).listen(PORT, "0.0.0.0", () => {
  console.log(`runner listening on ${PORT}`);
});
