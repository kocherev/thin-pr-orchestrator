import { runJob } from "./run-job.js";
import { createRunnerServer } from "./server.js";

const PORT = 8080;

const server = createRunnerServer(async (job) => {
  const record = await runJob(job, process.env);
  // One JSON line, so the container logs and `wrangler tail` carry the whole record.
  console.log(JSON.stringify(record ?? { deliveryId: job.deliveryId, status: "ignored", label: job.label }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`runner listening on ${PORT}`);
});
