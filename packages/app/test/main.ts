import { DurableObject } from "cloudflare:workers";

export { default } from "../src/worker.js";

export type RunnerRecord = {
  status: number;
  starts: { readonly name: string | undefined; readonly envVars: Record<string, string> }[];
  runs: { readonly name: string | undefined; readonly url: string; readonly job: unknown }[];
};

// The test Worker binds RUNNER to this class instead of the container, in the same isolate as the tests.
export const runner: RunnerRecord = { status: 202, starts: [], runs: [] };

export class FakeRunner extends DurableObject {
  async start(options: { readonly envVars: Record<string, string> }): Promise<void> {
    runner.starts.push({ name: this.ctx.id.name, envVars: options.envVars });
  }

  override async fetch(request: Request): Promise<Response> {
    runner.runs.push({ name: this.ctx.id.name, url: request.url, job: await request.json() });
    return new Response(null, { status: runner.status });
  }
}
