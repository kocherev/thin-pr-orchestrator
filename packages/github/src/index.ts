export const packageId = "@thin-pr/github" as const;

export type GitHubEntrypoint = "not-wired";

export function entrypoint(): GitHubEntrypoint {
  return "not-wired";
}
