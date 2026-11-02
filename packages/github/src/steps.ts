import type { StepHandler, StepId } from "@thin-pr/core";
import { createStepHandlers, type ModelSession, type Workspace } from "@thin-pr/specialists";
import type { GitWorkspace } from "@thin-pr/workspace";

type Installable = Workspace & Pick<GitWorkspace, "install">;

/** The handlers a run uses: the model steps, which edit through the workspace tools, and verify. */
export function createRunHandlers(session: ModelSession, workspace: Installable): Record<StepId, StepHandler> {
  return { ...createStepHandlers(session, workspace), verify: createVerifyHandler(workspace) };
}

/**
 * Runs the repo's install command once, before the first checks; a failed install fails the step. Then it runs
 * typecheck and test. A failed check loops back with each failing command and its log tail while the template
 * allows another loop. `context.loop` counts every pass over verify, so this never asks for more loops than core
 * permits. Once the loops are spent, the step finishes and the gate reports the failed check.
 */
export function createVerifyHandler(workspace: Installable): StepHandler {
  let installed: ReturnType<Installable["install"]> | null = null;
  return async (context) => {
    installed ??= workspace.install();
    const install = await installed;
    if (install && install.exitCode !== 0) {
      throw new Error(`install failed (exit ${install.exitCode}): ${install.command}\n${install.logTail}`);
    }
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
