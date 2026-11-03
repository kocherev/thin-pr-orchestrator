import type { StepHandler, StepId } from "@thin-pr/core";
import { createStepHandlers, type ModelSession, type Workspace } from "@thin-pr/specialists";

/**
 * The handlers a run uses: the model steps, which edit through the workspace tools, and verify. The session belongs
 * to this run, so its meter takes the run's `spendUsd` as a cap.
 */
export function createRunHandlers(
  session: ModelSession,
  workspace: Workspace,
  limits: { readonly spendUsd: number },
): Record<StepId, StepHandler> {
  session.meter.limitRun(limits.spendUsd);
  return { ...createStepHandlers(session, workspace), verify: createVerifyHandler(workspace) };
}

/**
 * Runs typecheck, then test. A failed check loops back with each failing command and its log tail while the
 * template allows another loop. `context.loop` counts every pass over verify, so this never asks for more loops
 * than core permits. Once the loops are spent, the step finishes and the gate reports the failed check.
 */
export function createVerifyHandler(workspace: Workspace): StepHandler {
  return async (context) => {
    const checks = [await workspace.runCheck("typecheck"), await workspace.runCheck("test")];
    const failed = checks.filter((check) => check.exitCode !== 0);
    const summary = checks
      .map((check) => `${check.name} ${check.exitCode === 0 ? "passed" : `failed (exit ${check.exitCode})`}`)
      .join("; ");
    const output = { summary: `${summary}.`, checks };
    if (failed.length === 0 || context.loop >= (context.step.loop?.max ?? 0)) {
      return { outcome: "done", output };
    }
    const feedback = failed.map((check) => `${check.name} failed (exit ${check.exitCode}): ${check.command}\n${check.logTail}`);
    return { outcome: "loop", output, feedback: feedback.join("\n\n") };
  };
}
