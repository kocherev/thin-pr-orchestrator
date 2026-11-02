import { StepError, type Json, type StepContext, type StepHandler, type StepId } from "@thin-pr/core";
import { z } from "zod";
import type { SpecialistName } from "./contract.js";
import type { ModelSession } from "./client.js";
import { runImplementer } from "./implementer.js";
import { pricedModel, type PricedModel } from "./pricing.js";
import { PLANNER_SYSTEM, PR_WRITER_SYSTEM, REVIEWER_SYSTEM } from "./prompts.js";
import { structured, type Effort } from "./structured.js";
import type { CheckResult, Workspace } from "./workspace.js";

const text = z.string().min(1);

export const plannerOutput = z.object({ summary: text, steps: z.array(text).min(1) }).strict();

/** `files` comes from the workspace diff, never from the model. */
export const implementerOutput = z.object({ summary: text, files: z.array(text) }).strict();

export const checkResult = z
  .object({
    name: z.enum(["typecheck", "test"]),
    command: z.string(),
    exitCode: z.number().int(),
    durationMs: z.number(),
    logTail: z.string(),
  })
  .strict() satisfies z.ZodType<CheckResult>;

/** The verify step's output: a one-line summary and each check result. */
export const verifyOutput = z.object({ summary: text, checks: z.array(checkResult) }).strict();

export const reviewerOutput = z
  .object({ summary: text, verdict: z.enum(["approve", "changes_requested"]), notes: z.array(z.string()) })
  .strict();

export const prWriterOutput = z.object({ summary: text, title: text, body: text }).strict();

/** The steps a model answers. `verify` runs the repo's checks instead. */
type ModelStepId = Exclude<StepId, "verify">;

// Used when a template step names no model or effort.
const DEFAULTS: Record<ModelStepId, { readonly specialist: SpecialistName; readonly model: PricedModel; readonly effort: Effort }> = {
  plan: { specialist: "planner", model: "claude-sonnet-5-5", effort: "medium" },
  implement: { specialist: "implementer", model: "claude-opus-5-5", effort: "high" },
  review: { specialist: "reviewer", model: "claude-sonnet-5-5", effort: "high" },
  write: { specialist: "pr-writer", model: "claude-haiku-5-5", effort: "low" },
};

/** One handler per model step. Each returns the usage of the calls it made. */
export function createStepHandlers(session: ModelSession, workspace: Workspace): Record<ModelStepId, StepHandler> {
  const { client, meter } = session;
  const route = (step: ModelStepId, context: StepContext) => ({
    specialist: DEFAULTS[step].specialist,
    model: pricedModel(context.step.model ?? DEFAULTS[step].model),
    effort: context.step.effort ?? DEFAULTS[step].effort,
    issue: context.issue,
  });
  const metered = (step: StepHandler): StepHandler => {
    return async (context) => {
      const before = meter.usage.length;
      try {
        const result = await step(context);
        return { ...result, usage: meter.usage.slice(before) };
      } catch (error) {
        const usage = meter.usage.slice(before);
        throw usage.length > 0 ? new StepError(error, usage) : error;
      }
    };
  };

  return {
    plan: metered(async (context) => {
      const input = withFeedback("Plan the change.", context.feedback);
      const output = await structured(client, { ...route("plan", context), system: PLANNER_SYSTEM, input, schema: plannerOutput });
      return { outcome: "done", output };
    }),
    implement: metered(async (context) => {
      const plan = plannerOutput.parse(context.outputs.plan);
      const input = withFeedback(`Plan: ${plan.summary}\n${bullets(plan.steps)}`, context.feedback);
      const summary = await runImplementer(client, { ...route("implement", context), input, workspace });
      const files = (await workspace.diff()).files.map((file) => file.path);
      return { outcome: "done", output: { summary, files } };
    }),
    review: metered(async (context) => {
      const plan = plannerOutput.parse(context.outputs.plan);
      const { checks } = verifyOutput.parse(context.outputs.verify);
      const { patch } = await workspace.diff();
      const input = [
        `Plan: ${plan.summary}\n${bullets(plan.steps)}`,
        `Diff:\n${patch.length > 0 ? patch : "(empty)"}`,
        `Checks:\n${checks.map((check) => `${check.name} exited ${check.exitCode}: ${check.command}\n${check.logTail}`).join("\n")}`,
      ].join("\n\n");
      const output = await structured(client, { ...route("review", context), system: REVIEWER_SYSTEM, input, schema: reviewerOutput });
      // Like verify, the last allowed pass finishes, so the gate reports the verdict instead of the run failing.
      if (output.verdict === "approve" || context.loop >= (context.step.loop?.max ?? 0)) {
        return { outcome: "done", output };
      }
      return { outcome: "loop", output, feedback: `Review notes:\n${bullets(output.notes)}` };
    }),
    write: metered(async (context) => {
      const { files } = implementerOutput.parse(context.outputs.implement);
      const input = [
        `Plan: ${summaryOf(context.outputs.plan)}`,
        `Change: ${summaryOf(context.outputs.implement)}`,
        `Files: ${files.join(", ")}`,
        `Review: ${summaryOf(context.outputs.review)}`,
      ].join("\n");
      const output = await structured(client, { ...route("write", context), system: PR_WRITER_SYSTEM, input, schema: prWriterOutput });
      return { outcome: "done", output };
    }),
  };
}

/** The `summary` field every step output carries, or "" when it is missing. */
export function summaryOf(output: Json | undefined): string {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return "";
  }
  return typeof output.summary === "string" ? output.summary : "";
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function withFeedback(input: string, feedback: string | null): string {
  return feedback ? `${input}\n\nFeedback from the last attempt:\n${feedback}` : input;
}
