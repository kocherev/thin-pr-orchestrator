export type GitHubRest = {
  pulls: {
    create(params: {
      readonly owner: string;
      readonly repo: string;
      readonly title: string;
      readonly head: string;
      readonly base: string;
      readonly body: string;
      readonly draft: true;
    }): Promise<{ data: { number: number; html_url: string } }>;
    list(params: {
      readonly owner: string;
      readonly repo: string;
      readonly head: string;
      readonly state: "open";
    }): Promise<{ data: readonly { number: number; html_url: string }[] }>;
    update(params: {
      readonly owner: string;
      readonly repo: string;
      readonly pull_number: number;
      readonly body: string;
    }): Promise<{ data: { number: number; html_url: string } }>;
    get(params: { readonly owner: string; readonly repo: string; readonly pull_number: number }): Promise<{
      data: {
        number: number;
        state: string;
        head: { ref: string; repo: { full_name: string } | null };
        base: { repo: { full_name: string } };
      };
    }>;
  };
  checks: {
    create(params: {
      readonly owner: string;
      readonly repo: string;
      readonly name: string;
      readonly head_sha: string;
      readonly status: "in_progress";
      readonly started_at: string;
    }): Promise<{ data: { id: number } }>;
    update(params: {
      readonly owner: string;
      readonly repo: string;
      readonly check_run_id: number;
      readonly status: "completed";
      readonly conclusion: CheckConclusion;
      readonly completed_at: string;
      readonly output: { readonly title: string; readonly summary: string };
    }): Promise<unknown>;
  };
  git: {
    getRef(params: { readonly owner: string; readonly repo: string; readonly ref: string }): Promise<{
      data: { object: { sha: string } };
    }>;
    deleteRef(params: { readonly owner: string; readonly repo: string; readonly ref: string }): Promise<unknown>;
  };
  reactions: {
    createForIssueComment(params: {
      readonly owner: string;
      readonly repo: string;
      readonly comment_id: number;
      readonly content: Reaction;
    }): Promise<{ data: { user: { login: string } | null } }>;
  };
  issues: {
    createComment(params: {
      readonly owner: string;
      readonly repo: string;
      readonly issue_number: number;
      readonly body: string;
    }): Promise<{ data: { id: number } }>;
    updateComment(params: {
      readonly owner: string;
      readonly repo: string;
      readonly comment_id: number;
      readonly body: string;
    }): Promise<unknown>;
    listComments(params: {
      readonly owner: string;
      readonly repo: string;
      readonly issue_number: number;
      readonly per_page: number;
      readonly page: number;
    }): Promise<{ data: readonly { id: number; body?: string; user: { login: string } | null }[] }>;
    get(params: { readonly owner: string; readonly repo: string; readonly issue_number: number }): Promise<{
      data: { number: number; title: string; body?: string | null; labels: readonly (string | { name?: string })[] };
    }>;
  };
};

type PullRequest = { readonly number: number; readonly url: string };

/** The reactions a run leaves on a command: seen, done, and refused. */
export type Reaction = "eyes" | "+1" | "confused";

export type IssueComment = { readonly id: number; readonly author: string | null; readonly body: string };

export type Issue = { readonly number: number; readonly title: string; readonly body: string; readonly labels: readonly string[] };

const COMMENTS_PER_PAGE = 100;

/** `neutral` marks a rule that waits for a person, such as `budget` with `NEEDS_APPROVAL`. */
type CheckConclusion = "success" | "failure" | "neutral";

export type GitHubSurface = {
  startCheck(input: {
    readonly owner: string;
    readonly repo: string;
    readonly name: string;
    readonly sha: string;
  }): Promise<number>;
  finishCheck(input: {
    readonly owner: string;
    readonly repo: string;
    readonly checkRunId: number;
    readonly conclusion: CheckConclusion;
    readonly summary: string;
    readonly title?: string;
  }): Promise<void>;
  /** Comments on an issue or pull request and returns the comment id. */
  createComment(input: {
    readonly owner: string;
    readonly repo: string;
    readonly issue: number;
    readonly body: string;
  }): Promise<number>;
  editComment(input: {
    readonly owner: string;
    readonly repo: string;
    readonly commentId: number;
    readonly body: string;
  }): Promise<void>;
  /** Every comment on an issue or pull request, oldest first. */
  listComments(input: { readonly owner: string; readonly repo: string; readonly issue: number }): Promise<IssueComment[]>;
  /**
   * Reacts to an issue comment and returns the login that reacted, which is the token's own account. An
   * installation token cannot read `GET /user`, and the command flow reacts anyway, so this is how it learns who
   * it is.
   */
  react(input: { readonly owner: string; readonly repo: string; readonly commentId: number; readonly content: Reaction }): Promise<string>;
  getIssue(input: { readonly owner: string; readonly repo: string; readonly issue: number }): Promise<Issue>;
  /** The head branch of a pull request, and whether it lives in the same repository. */
  getPull(input: { readonly owner: string; readonly repo: string; readonly number: number }): Promise<{
    readonly number: number;
    readonly open: boolean;
    readonly branch: string;
    readonly sameRepo: boolean;
  }>;
  deleteBranch(input: { readonly owner: string; readonly repo: string; readonly branch: string }): Promise<void>;
  /** The commit `branch` points at, or null when the branch does not exist. */
  branchHead(input: { readonly owner: string; readonly repo: string; readonly branch: string }): Promise<string | null>;
  /** Open pull requests whose head is `branch` in the same repo. */
  listPullsForHead(input: { readonly owner: string; readonly repo: string; readonly branch: string }): Promise<PullRequest[]>;
  updatePull(input: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
    readonly body: string;
  }): Promise<PullRequest>;
  openDraft(input: {
    readonly owner: string;
    readonly repo: string;
    readonly title: string;
    readonly head: string;
    readonly base: string;
    readonly body: string;
    readonly draft: true;
  }): Promise<PullRequest>;
};

export function createGitHubSurface(octokit: GitHubRest): GitHubSurface {
  return {
    async startCheck(input) {
      const { data } = await octokit.checks.create({
        owner: input.owner,
        repo: input.repo,
        name: input.name,
        head_sha: input.sha,
        status: "in_progress",
        started_at: new Date().toISOString(),
      });
      return data.id;
    },
    async finishCheck(input) {
      await octokit.checks.update({
        owner: input.owner,
        repo: input.repo,
        check_run_id: input.checkRunId,
        status: "completed",
        conclusion: input.conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: input.title ?? { success: "Passed", failure: "Failed", neutral: "Needs approval" }[input.conclusion],
          summary: input.summary,
        },
      });
    },
    async createComment(input) {
      const { data } = await octokit.issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issue,
        body: input.body,
      });
      return data.id;
    },
    async editComment(input) {
      await octokit.issues.updateComment({
        owner: input.owner,
        repo: input.repo,
        comment_id: input.commentId,
        body: input.body,
      });
    },
    async listComments(input) {
      const comments: IssueComment[] = [];
      for (let page = 1; ; page += 1) {
        const { data } = await octokit.issues.listComments({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.issue,
          per_page: COMMENTS_PER_PAGE,
          page,
        });
        comments.push(...data.map((comment) => ({ id: comment.id, author: comment.user?.login ?? null, body: comment.body ?? "" })));
        if (data.length < COMMENTS_PER_PAGE) {
          return comments;
        }
      }
    },
    async react(input) {
      const { data } = await octokit.reactions.createForIssueComment({
        owner: input.owner,
        repo: input.repo,
        comment_id: input.commentId,
        content: input.content,
      });
      if (!data.user) {
        throw new Error("GitHub returned a reaction without a user");
      }
      return data.user.login;
    },
    async getIssue(input) {
      const { data } = await octokit.issues.get({ owner: input.owner, repo: input.repo, issue_number: input.issue });
      return {
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        labels: data.labels.flatMap((label) => {
          const name = typeof label === "string" ? label : label.name;
          return name ? [name] : [];
        }),
      };
    },
    async getPull(input) {
      const { data } = await octokit.pulls.get({ owner: input.owner, repo: input.repo, pull_number: input.number });
      return {
        number: data.number,
        open: data.state === "open",
        branch: data.head.ref,
        sameRepo: data.head.repo?.full_name === data.base.repo.full_name,
      };
    },
    async deleteBranch(input) {
      await octokit.git.deleteRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.branch}` });
    },
    async branchHead(input) {
      try {
        const { data } = await octokit.git.getRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.branch}` });
        return data.object.sha;
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    async listPullsForHead(input) {
      const { data } = await octokit.pulls.list({
        owner: input.owner,
        repo: input.repo,
        head: `${input.owner}:${input.branch}`,
        state: "open",
      });
      return data.map((pull) => ({ number: pull.number, url: pull.html_url }));
    },
    async updatePull(input) {
      const { data } = await octokit.pulls.update({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.number,
        body: input.body,
      });
      return { number: data.number, url: data.html_url };
    },
    async openDraft(input) {
      const { data } = await octokit.pulls.create({
        owner: input.owner,
        repo: input.repo,
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        draft: true,
      });
      return { number: data.number, url: data.html_url };
    },
  };
}

/** The methods only commands and reviews call, for a surface that runs labeled issues alone. Each one throws. */
export function noReadBack(who: string): Pick<GitHubSurface, "listComments" | "react" | "getIssue" | "getPull" | "deleteBranch"> {
  const refuse = async (): Promise<never> => {
    throw new Error(`${who} runs labeled issues only`);
  };
  return { listComments: refuse, react: refuse, getIssue: refuse, getPull: refuse, deleteBranch: refuse };
}
