import { z } from "zod";

// GitHub sends many more fields. These are the ones a run reads.
const payloadSchema = z.object({
  action: z.string().min(1),
  label: z.object({ name: z.string().min(1) }),
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string().nullish(),
  }),
  repository: z.object({
    name: z.string().min(1),
    default_branch: z.string().min(1),
    owner: z.object({ login: z.string().min(1) }),
  }),
});

export type LabelEvent = {
  readonly action: string;
  readonly label: string;
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string;
  readonly issue: { readonly number: number; readonly title: string; readonly body: string; readonly url: string };
  /** The issue as the steps see it: number, title and body. */
  readonly issueText: string;
};

export function readLabelEvent(payload: unknown): LabelEvent {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`event payload invalid at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`);
  }
  const { action, label, issue, repository } = parsed.data;
  const body = issue.body ?? "";
  const heading = `#${issue.number} ${issue.title}`;
  return {
    action,
    label: label.name,
    owner: repository.owner.login,
    repo: repository.name,
    defaultBranch: repository.default_branch,
    issue: {
      number: issue.number,
      title: issue.title,
      body,
      url: `https://github.com/${repository.owner.login}/${repository.name}/issues/${issue.number}`,
    },
    issueText: body.length === 0 ? heading : `${heading}\n\n${body}`,
  };
}
