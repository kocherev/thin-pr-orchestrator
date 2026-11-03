import { STEP_IDS } from "@thin-pr/core";
import { decideResults, GATE_RULES, GATE_VERDICTS } from "@thin-pr/gate";
import { checkResult, plannerOutput, reviewerOutput } from "@thin-pr/specialists";
import { z } from "zod";
import type { RunRecord } from "./record.js";
import { formatRunReport } from "./report.js";
import type { GitHubSurface } from "./surface.js";

// A stored step summary keeps its first line or so. The full text is in the report above the marker.
const STORED_SUMMARY_CHARS = 300;
const MARKER = /<!-- thin-pr-run:([A-Za-z0-9+/=]+) -->/g;

const count = z.number().int().nonnegative();

const runRecord = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1),
    repo: z.string().regex(/^[^/]+\/[^/]+$/),
    issue: z.object({ number: z.number().int().positive(), title: z.string(), url: z.string() }).strict(),
    template: z.string().min(1),
    status: z.enum(["opened", "awaiting_approval", "blocked", "failed"]),
    steps: z.array(
      z
        .object({
          id: z.enum(STEP_IDS),
          attempt: z.number().int().positive(),
          loop: count,
          outcome: z.enum(["finished", "looped", "failed"]),
          startedAt: z.string(),
          durationMs: z.number(),
          usage: z.array(
            z
              .object({
                model: z.string(),
                inputTokens: count,
                outputTokens: count,
                cacheReadTokens: count,
                costUsd: z.number(),
                durationMs: z.number(),
              })
              .strict(),
          ),
          summary: z.string(),
        })
        .strict(),
    ),
    gate: z.array(z.object({ rule: z.enum(GATE_RULES), verdict: z.enum(GATE_VERDICTS), reason: z.string() }).strict()),
    diff: z
      .object({
        files: z.array(z.object({ path: z.string(), added: count, removed: count }).strict()),
        meaningful: z.boolean(),
        patch: z.string(),
      })
      .strict()
      .nullable(),
    checks: z.array(checkResult),
    pullRequest: z.object({ number: z.number().int().positive(), url: z.string() }).strict().nullable(),
    totals: z.object({ costUsd: z.number(), durationMs: z.number(), inputTokens: count, outputTokens: count }).strict(),
  })
  .strict() satisfies z.ZodType<RunRecord>;

/**
 * What a run that waits for approval keeps in its issue comment, so a later `/thin-pr approve` can re-check it and
 * open the draft. `branch.head` is the commit the gate measured. The record leaves out the patch, which the branch
 * holds, and cuts step summaries short.
 */
export type StoredRun = {
  readonly version: 1;
  readonly record: RunRecord;
  readonly branch: { readonly name: string; readonly head: string; readonly base: string };
  readonly title: string;
  readonly plan: z.infer<typeof plannerOutput> | null;
  readonly review: z.infer<typeof reviewerOutput> | null;
};

const storedRun = z
  .object({
    version: z.literal(1),
    record: runRecord,
    branch: z.object({ name: z.string().min(1), head: z.string().regex(/^[0-9a-f]{40}$/), base: z.string().min(1) }).strict(),
    title: z.string().min(1),
    plan: plannerOutput.nullable(),
    review: reviewerOutput.nullable(),
  })
  .strict() satisfies z.ZodType<StoredRun>;

export type ApprovalResult =
  | { readonly status: "opened"; readonly record: RunRecord }
  | { readonly status: "refused"; readonly reason: string };

export function toStoredRun(input: Omit<StoredRun, "version" | "record"> & { readonly record: RunRecord }): StoredRun {
  const { record } = input;
  return {
    ...input,
    version: 1,
    record: {
      ...record,
      diff: record.diff && { ...record.diff, patch: "" },
      steps: record.steps.map((step) => ({ ...step, summary: step.summary.slice(0, STORED_SUMMARY_CHARS) })),
    },
  };
}

/** A hidden HTML comment that carries the stored run. Base64 keeps `-->` in a log from ending it early. */
export function storedRunMarker(stored: StoredRun): string {
  return `<!-- thin-pr-run:${Buffer.from(JSON.stringify(stored)).toString("base64")} -->`;
}

/**
 * The last stored run in a comment body, or null when there is none or it does not parse. Anyone can write a
 * marker in a comment, so read only the comments the thin-pr app or workflow posted.
 */
export function readStoredRun(body: string): StoredRun | null {
  const encoded = [...body.matchAll(MARKER)].at(-1)?.[1];
  if (!encoded) {
    return null;
  }
  try {
    const parsed = storedRun.safeParse(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Opens the draft for a run that waits for approval. It re-checks first: the stored run must be
 * `awaiting_approval`, its stored gate results must still decide `needs_approval`, and the branch must still point at
 * the commit the gate measured. A branch that moved after the run is refused, since nobody gated the new commits.
 * An open pull request for the branch gets the new body instead of a second draft. Nothing is commented.
 */
export async function openApprovedDraft(
  stored: StoredRun,
  deps: { readonly github: GitHubSurface; readonly approvedBy: string },
): Promise<ApprovalResult> {
  const { record, branch } = stored;
  if (record.status !== "awaiting_approval") {
    return { status: "refused", reason: `Run ${record.runId} is ${record.status}, not awaiting approval.` };
  }
  const decision = decideResults(record.gate);
  if (decision !== "needs_approval") {
    return { status: "refused", reason: `The stored gate results decide ${decision}, not needs_approval.` };
  }
  const [owner = "", repo = ""] = record.repo.split("/");
  const target = { owner, repo };
  const head = await deps.github.branchHead({ ...target, branch: branch.name });
  if (head !== branch.head) {
    const now = head === null ? "is gone" : `now points at ${head.slice(0, 7)}`;
    return {
      status: "refused",
      reason: `\`${branch.name}\` ${now}, and the gate measured ${branch.head.slice(0, 7)}. Run thin-pr again to gate the branch as it is.`,
    };
  }

  const opened: RunRecord = { ...record, status: "opened" };
  const outputs = { ...(stored.plan && { plan: stored.plan }), ...(stored.review && { review: stored.review }) };
  const body = formatRunReport({ record: opened, outputs, branch: branch.name, error: null, approvedBy: deps.approvedBy });
  const [open] = await deps.github.listPullsForHead({ ...target, branch: branch.name });
  const pullRequest = open
    ? await deps.github.updatePull({ ...target, number: open.number, body })
    : await deps.github.openDraft({ ...target, title: stored.title, head: branch.name, base: branch.base, body, draft: true });
  return { status: "opened", record: { ...opened, pullRequest } };
}
