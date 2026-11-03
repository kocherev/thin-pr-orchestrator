import { execFileSync } from "node:child_process";
import type { GitHubSurface, Issue } from "./surface.js";

/** One recorded surface call: the method name and its input. */
export type Call = { readonly op: string } & Readonly<Record<string, unknown>>;

export type StoredComment = { readonly id: number; readonly issue: number; readonly author: string; body: string };

/**
 * An in-memory GitHub for tests. It records every call, keeps comments so a later command can read them back, and
 * reads branch heads from `remote`, the bare repo a run pushes to.
 */
export function memoryGitHub(options?: {
  readonly openPull?: { readonly number: number; readonly url: string };
  readonly remote?: string;
  /** The token's own login: the author of every comment the surface creates. */
  readonly self?: string;
  readonly comments?: readonly StoredComment[];
  readonly issues?: Readonly<Record<number, Issue>>;
  readonly pulls?: Readonly<Record<number, { readonly branch: string; readonly sameRepo?: boolean }>>;
}) {
  const calls: Call[] = [];
  const self = options?.self ?? "thin-pr[bot]";
  const comments: StoredComment[] = (options?.comments ?? []).map((comment) => ({ ...comment }));
  let nextId = 1;
  const id = () => {
    nextId += 1;
    return nextId - 1;
  };
  const head = (branch: string): string | null => {
    if (!options?.remote) {
      return null;
    }
    const refs = git(options.remote, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
    return refs.length > 0 ? refs : null;
  };

  const github: GitHubSurface = {
    async startCheck(input) {
      calls.push({ op: "startCheck", ...input });
      return id();
    },
    async finishCheck(input) {
      calls.push({ op: "finishCheck", ...input });
    },
    async createComment(input) {
      calls.push({ op: "createComment", ...input });
      const comment = { id: 1000 + id(), issue: input.issue, author: self, body: input.body };
      comments.push(comment);
      return comment.id;
    },
    async editComment(input) {
      calls.push({ op: "editComment", ...input });
      const comment = comments.find((candidate) => candidate.id === input.commentId);
      if (!comment) {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }
      comment.body = input.body;
    },
    async listComments(input) {
      calls.push({ op: "listComments", ...input });
      return comments.filter((comment) => comment.issue === input.issue).map(({ id, author, body }) => ({ id, author, body }));
    },
    async react(input) {
      calls.push({ op: "react", ...input });
      return self;
    },
    async getIssue(input) {
      calls.push({ op: "getIssue", ...input });
      const issue = options?.issues?.[input.issue];
      if (!issue) {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }
      return issue;
    },
    async getPull(input) {
      calls.push({ op: "getPull", ...input });
      const pull = options?.pulls?.[input.number];
      if (!pull) {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }
      return { number: input.number, open: true, branch: pull.branch, sameRepo: pull.sameRepo ?? true };
    },
    async deleteBranch(input) {
      calls.push({ op: "deleteBranch", ...input });
      if (options?.remote) {
        git(options.remote, "update-ref", "-d", `refs/heads/${input.branch}`);
      }
    },
    async branchHead(input) {
      calls.push({ op: "branchHead", ...input });
      return head(input.branch);
    },
    async listPullsForHead(input) {
      calls.push({ op: "listPullsForHead", ...input });
      return options?.openPull ? [options.openPull] : [];
    },
    async updatePull(input) {
      calls.push({ op: "updatePull", ...input });
      return { number: input.number, url: `https://github.com/${input.owner}/${input.repo}/pull/${input.number}` };
    },
    async openDraft(input) {
      calls.push({ op: "openDraft", ...input });
      return { number: 11, url: `https://github.com/${input.owner}/${input.repo}/pull/11` };
    },
  };
  return { github, calls, comments };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
