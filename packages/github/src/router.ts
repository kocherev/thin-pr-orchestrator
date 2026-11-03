import { z } from "zod";

// This module imports only zod, so the Worker can bundle it next to the Action's entry.

/** `thin-pr` or `thin-pr:<template>`. Which template a label names is up to the templates directory. */
export const TRIGGER_LABEL = /^thin-pr(?::[a-z0-9][a-z0-9-]*)?$/;

/** The associations GitHub gives users with write access. Everyone else is ignored, not answered. */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export const COMMANDS = ["approve", "retry", "cancel"] as const;

/** The template a review starts. A label run never uses it. */
export const REVISE_LABEL = "thin-pr:revise";

const DRAFT_BRANCH = /^thin-pr\/(\d+)$/;

// GitHub sends review states in lower case in webhooks. Approvals ask for nothing.
const REVISE_STATES = new Set(["changes_requested", "commented"]);

// Names that go into clone URLs and API paths.
const githubName = z.string().regex(/^[A-Za-z0-9_.-]+$/);
const positive = z.number().int().positive();

const repoSchema = z.object({ owner: githubName, name: githubName, defaultBranch: z.string().min(1) }).strict();
const issueSchema = z.object({ number: positive, title: z.string().min(1), body: z.string() }).strict();

/** What an event asks for, with only the fields a run reads. The Worker queues it as is. */
export const triggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("label"), repo: repoSchema, issue: issueSchema, label: z.string().regex(TRIGGER_LABEL) }).strict(),
  z
    .object({
      kind: z.literal("command"),
      repo: repoSchema,
      /** `pull` is true for a comment on a pull request, which GitHub also sends as `issue_comment`. */
      issue: issueSchema.extend({ labels: z.array(z.string()), pull: z.boolean() }).strict(),
      command: z.enum([...COMMANDS, "help"]),
      comment: z.object({ id: positive, author: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("revise"),
      repo: repoSchema,
      /** An open draft on `thin-pr/<issue>` in the same repository. */
      pull: z.object({ number: positive, branch: z.string().regex(DRAFT_BRANCH), issue: positive }).strict(),
      /** A review, and the review an inline comment belongs to, both name the review. */
      reviewId: positive,
      reviewer: z.string().min(1),
    })
    .strict(),
]);

export type Trigger = z.infer<typeof triggerSchema>;
export type CommandTrigger = Extract<Trigger, { kind: "command" }>;
export type ReviseTrigger = Extract<Trigger, { kind: "revise" }>;

export type Route =
  | { readonly kind: "run"; readonly trigger: Trigger; readonly installationId: number | null }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

// GitHub sends many more fields. These are the ones the router reads.
const user = z.object({ login: z.string().min(1), type: z.string() });
// Some events, such as ping and push, have no action.
const envelope = z.object({
  action: z.string().optional(),
  sender: user.optional(),
  installation: z.object({ id: positive }).optional(),
});
const repository = z.object({ name: z.string(), default_branch: z.string(), owner: z.object({ login: z.string() }) });
const issue = z.object({ number: z.number(), title: z.string(), body: z.string().nullish() });

const labeledPayload = z.object({ label: z.object({ name: z.string() }), issue, repository });
const commentPayload = z.object({
  issue: issue.extend({
    labels: z.array(z.object({ name: z.string() })).default([]),
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({ id: z.number(), body: z.string().nullish(), user, author_association: z.string() }),
  repository,
});
const pullRequest = z.object({
  number: z.number(),
  state: z.string(),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});
const reviewPayload = z.object({
  review: z.object({ id: z.number(), state: z.string(), user, author_association: z.string() }),
  pull_request: pullRequest,
  repository,
});
const reviewCommentPayload = z.object({
  comment: z.object({ pull_request_review_id: z.number().nullable(), user, author_association: z.string() }),
  pull_request: pullRequest,
  repository,
});

/**
 * Maps one webhook event to a trigger. `name` is the `X-GitHub-Event` header or the Action's event name. Events
 * from bots never start anything, so the app cannot answer its own comments.
 */
export function routeEvent(name: string, payload: unknown): Route {
  const head = envelope.safeParse(payload);
  if (!head.success) {
    return invalid(head.error);
  }
  const { action, sender, installation } = head.data;
  if (sender?.type === "Bot") {
    return ignored(`sent by the bot ${sender.login}`);
  }
  const installationId = installation?.id ?? null;
  const run = (trigger: unknown): Route => {
    const parsed = triggerSchema.safeParse(trigger);
    return parsed.success ? { kind: "run", trigger: parsed.data, installationId } : invalid(parsed.error);
  };

  if (name === "issues" && action === "labeled") {
    const event = labeledPayload.safeParse(payload);
    if (!event.success) {
      return invalid(event.error);
    }
    if (!TRIGGER_LABEL.test(event.data.label.name)) {
      return ignored(`label ${event.data.label.name} is not a thin-pr label`);
    }
    return run({
      kind: "label",
      repo: repoOf(event.data.repository),
      issue: issueOf(event.data.issue),
      label: event.data.label.name,
    });
  }

  if (name === "issue_comment" && action === "created") {
    const event = commentPayload.safeParse(payload);
    if (!event.success) {
      return invalid(event.error);
    }
    const { comment } = event.data;
    const command = parseCommand(comment.body ?? "");
    if (command === null) {
      return ignored("the comment is not a /thin-pr command");
    }
    const outsider = untrusted(comment.user, comment.author_association);
    if (outsider) {
      return ignored(outsider);
    }
    return run({
      kind: "command",
      repo: repoOf(event.data.repository),
      issue: {
        ...issueOf(event.data.issue),
        labels: event.data.issue.labels.map((label) => label.name),
        pull: event.data.issue.pull_request !== undefined,
      },
      command,
      comment: { id: comment.id, author: comment.user.login },
    });
  }

  // GitHub sends one review event per review and one comment event per inline comment in it. Both carry the review
  // id, and the revise run answers each review once.
  if ((name === "pull_request_review" && action === "submitted") || (name === "pull_request_review_comment" && action === "created")) {
    const event = name === "pull_request_review" ? reviewPayload.safeParse(payload) : reviewCommentPayload.safeParse(payload);
    if (!event.success) {
      return invalid(event.error);
    }
    const author = "review" in event.data ? event.data.review : event.data.comment;
    const reviewId = "review" in event.data ? event.data.review.id : event.data.comment.pull_request_review_id;
    if ("review" in event.data && !REVISE_STATES.has(event.data.review.state.toLowerCase())) {
      return ignored(`a review that is ${event.data.review.state.toLowerCase()} asks for no change`);
    }
    if (reviewId === null) {
      return ignored("the comment belongs to no review");
    }
    const pull = draftOf(event.data.pull_request);
    if (typeof pull === "string") {
      return ignored(pull);
    }
    const outsider = untrusted(author.user, author.author_association);
    if (outsider) {
      return ignored(outsider);
    }
    return run({ kind: "revise", repo: repoOf(event.data.repository), pull, reviewId, reviewer: author.user.login });
  }

  return ignored(`${name}${action ? `.${action}` : ""} does not start a run`);
}

/** The draft's number, branch and issue, or why the pull request is not one thin-pr revises. */
function draftOf(pull: z.infer<typeof pullRequest>): { number: number; branch: string; issue: number } | string {
  const match = DRAFT_BRANCH.exec(pull.head.ref);
  if (!match) {
    return `${pull.head.ref} is not a thin-pr branch`;
  }
  if (pull.head.repo?.full_name !== pull.base.repo.full_name) {
    return "the pull request comes from a fork";
  }
  if (pull.state !== "open") {
    return `the pull request is ${pull.state}`;
  }
  return { number: pull.number, branch: pull.head.ref, issue: Number(match[1]) };
}

/** The command on the first line of a comment, `help` for an unknown word, or null when it is not a command. */
export function parseCommand(body: string): CommandTrigger["command"] | null {
  const match = /^\/thin-pr(?:\s+(\S+))?(?=\s|$)/.exec(body.trimStart().split("\n")[0]?.trim() ?? "");
  if (!match) {
    return null;
  }
  const word = (match[1] ?? "").toLowerCase();
  return COMMANDS.find((command) => command === word) ?? "help";
}

function untrusted(author: z.infer<typeof user>, association: string): string | null {
  if (author.type === "Bot") {
    return `written by the bot ${author.login}`;
  }
  return TRUSTED.has(association) ? null : `${author.login} is ${association}, not a user with write access`;
}

function repoOf(data: z.infer<typeof repository>) {
  return { owner: data.owner.login, name: data.name, defaultBranch: data.default_branch };
}

function issueOf(data: z.infer<typeof issue>) {
  return { number: data.number, title: data.title, body: data.body ?? "" };
}

function ignored(reason: string): Route {
  return { kind: "ignored", reason };
}

function invalid(error: z.ZodError): Route {
  const issue = error.issues[0];
  return { kind: "invalid", reason: issue ? `${issue.path.join(".") || "payload"}: ${issue.message}` : "invalid payload" };
}
