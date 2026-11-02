import type { StepHandler, StepId } from "@thin-pr/core";
import { createStepHandlers, implementerOutput, type CheckResult, type ModelClient, type Workspace } from "@thin-pr/specialists";
import type { GitWorkspace } from "@thin-pr/workspace";
import { z } from "zod";

const checkResult = z
  .object({
    name: z.enum(["typecheck", "test"]),
    command: z.string(),
    exitCode: z.number().int(),
    durationMs: z.number(),
    logTail: z.string(),
  })
  .strict() satisfies z.ZodType<CheckResult>;

/** The verify step's output: a one-line summary and each check result. */
export const verifyOutput = z.object({ summary: z.string().min(1), checks: z.array(checkResult) }).strict();

type Installable = Workspace & Pick<GitWorkspace, "install">;

/** The handlers a run uses: the model steps, implement with its edits applied to the workspace, and verify. */
export function createRunHandlers(model: ModelClient, workspace: Installable): Record<StepId, StepHandler> {
  const steps = createStepHandlers(model);
  return { ...steps, implement: withEdits(steps.implement, workspace), verify: createVerifyHandler(workspace) };
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

// shortcut: the implementer returns whole files, so each edit becomes a create or a full replace. Upgrade when the
// implementer edits through workspace tools.
function withEdits(implement: StepHandler, workspace: Workspace): StepHandler {
  return async (context) => {
    const result = await implement(context);
    for (const edit of implementerOutput.parse(result.output).edits ?? []) {
      const current = await workspace.readFile(edit.path);
      if (current === null) {
        await workspace.createFile(edit.path, edit.content);
      } else if (current !== edit.content) {
        await workspace.replace(edit.path, current, edit.content);
      }
    }
    return result;
  };
}
