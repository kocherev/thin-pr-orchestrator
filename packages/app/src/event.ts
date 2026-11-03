import { routeEvent, triggerSchema } from "@thin-pr/github/router";
import { z } from "zod";

/** One queued delivery: the trigger the shared router read from it, and the installation to act as. */
export const jobSchema = z
  .object({
    deliveryId: z.guid(),
    /**
     * Names the container and dedupes runs. A review arrives as one review event and one event per inline comment,
     * so all of them share `review-<id>` and run once. Every other job is keyed by its delivery.
     */
    key: z.string().regex(/^[A-Za-z0-9-]+$/),
    installationId: z.number().int().positive(),
    trigger: triggerSchema,
  })
  .strict();

export type Job = z.infer<typeof jobSchema>;

export type Delivery =
  | { readonly kind: "job"; readonly job: Job }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

export function readDelivery(headers: Headers, body: string): Delivery {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { kind: "invalid", reason: "body is not JSON" };
  }
  const route = routeEvent(headers.get("x-github-event") ?? "", payload);
  if (route.kind !== "run") {
    return route;
  }
  const deliveryId = headers.get("x-github-delivery");
  const job = jobSchema.safeParse({
    deliveryId,
    key: route.trigger.kind === "revise" ? `review-${route.trigger.reviewId}` : deliveryId,
    installationId: route.installationId,
    trigger: route.trigger,
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
