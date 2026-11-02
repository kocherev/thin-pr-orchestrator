import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// The eval cases check with bare tsc and vitest, so replay_case needs this repo's binaries, as pnpm eval does.
const bin = fileURLToPath(new URL("../../../node_modules/.bin", import.meta.url));
process.env.PATH = [bin, process.env.PATH].join(delimiter);

await createServer({ runsDir: process.env.THIN_PR_RUNS_DIR || undefined }).connect(new StdioServerTransport());
