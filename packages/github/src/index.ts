export const packageId = "@thin-pr/github" as const;

export type GitHubEntrypoint = "issue-label";

export function entrypoint(): GitHubEntrypoint {
  return "issue-label";
}

export {
  branchName,
  checkName,
  formatRunReport,
  readLabelEvent,
  runAction,
  runOnLabel,
  TRIGGER_LABEL,
} from "./run.js";
export type { LabelEvent, LabelRunDeps, LabelRunResult, RunReport, StepReport } from "./run.js";
export { createGitHubSurface, type GitHubRest, type GitHubSurface } from "./surface.js";
