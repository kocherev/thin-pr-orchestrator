import { z } from "zod";

const payloadSchema = z.looseObject({
  action: z.literal("completed"),
  workflow_run: z.looseObject({
    head_branch: z.string(),
    head_sha: z.string(),
    event: z.string(),
    conclusion: z.string().nullable(),
    name: z.string(),
    html_url: z.string(),
    head_repository: z.looseObject({ full_name: z.string() }),
  }),
  repository: z.looseObject({ full_name: z.string(), name: z.string(), owner: z.looseObject({ login: z.string() }) }),
});

/**
 * The `thin-pr / ci` check for a finished `workflow_run` event, or null. GitHub shows no check from a CI run that
 * thin-pr dispatched on its branch, so the Action posts that run's result on the commit. A run a person started,
 * another branch, and a fork's run are left alone.
 */
export function ciCheckFor(payload: unknown) {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  const { workflow_run: run, repository } = parsed.data;
  if (run.event !== "workflow_dispatch" || !run.head_branch.startsWith("thin-pr/") || run.head_repository.full_name !== repository.full_name) {
    return null;
  }
  const passed = run.conclusion === "success";
  return {
    owner: repository.owner.login,
    repo: repository.name,
    name: "thin-pr / ci",
    sha: run.head_sha,
    conclusion: passed ? ("success" as const) : ("failure" as const),
    title: `${run.name} ${passed ? "passed" : "failed"}`,
    summary: `[${run.name} run](${run.html_url}) on \`${run.head_branch}\` ended with ${run.conclusion ?? "no conclusion"}.`,
  };
}
