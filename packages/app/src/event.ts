import { z } from "zod";

const triggerLabel = z.string().regex(/^thin-pr(?::[a-z0-9][a-z0-9-]*)?$/);
const githubName = z.string().regex(/^[A-Za-z0-9_.-]+$/);

export const jobSchema = z
  .object({
    deliveryId: z.guid(),
    installationId: z.number().int().positive(),
    owner: githubName,
    repo: githubName,
    defaultBranch: z.string().min(1),
    issueNumber: z.number().int().positive(),
    issueTitle: z.string().min(1),
    issueBody: z.string(),
    label: triggerLabel,
  })
  .strict();

export type Job = z.infer<typeof jobSchema>;

export type Delivery =
  | { readonly kind: "job"; readonly job: Job }
  | { readonly kind: "ignored" }
  | { readonly kind: "invalid"; readonly reason: string };

const triggerSchema = z.object({
  action: z.literal("labeled"),
  label: z.object({ name: triggerLabel }),
});

const labeledIssueSchema = triggerSchema.extend({
  issue: z.object({ number: z.number(), title: z.string(), body: z.string().nullish() }),
  repository: z.object({ name: z.string(), default_branch: z.string(), owner: z.object({ login: z.string() }) }),
  installation: z.object({ id: z.number() }),
});

export function readDelivery(headers: Headers, body: string): Delivery {
  if (headers.get("x-github-event") !== "issues") {
    return { kind: "ignored" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { kind: "invalid", reason: "body is not JSON" };
  }
  if (!triggerSchema.safeParse(payload).success) {
    return { kind: "ignored" };
  }
  const event = labeledIssueSchema.safeParse(payload);
  if (!event.success) {
    return { kind: "invalid", reason: firstIssue(event.error) };
  }
  const job = jobSchema.safeParse({
    deliveryId: headers.get("x-github-delivery"),
    installationId: event.data.installation.id,
    owner: event.data.repository.owner.login,
    repo: event.data.repository.name,
    defaultBranch: event.data.repository.default_branch,
    issueNumber: event.data.issue.number,
    issueTitle: event.data.issue.title,
    issueBody: event.data.issue.body ?? "",
    label: event.data.label.name,
  });
  if (!job.success) {
    return { kind: "invalid", reason: firstIssue(job.error) };
  }
  return { kind: "job", job: job.data };
}

export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "value"}: ${issue.message}` : "invalid value";
}
