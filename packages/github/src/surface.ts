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
      readonly conclusion: "success" | "failure";
      readonly completed_at: string;
      readonly output: { readonly title: string; readonly summary: string };
    }): Promise<unknown>;
  };
  issues: {
    createComment(params: {
      readonly owner: string;
      readonly repo: string;
      readonly issue_number: number;
      readonly body: string;
    }): Promise<unknown>;
  };
};

type PullRequest = { readonly number: number; readonly url: string };

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
    readonly conclusion: "success" | "failure";
    readonly summary: string;
    readonly title?: string;
  }): Promise<void>;
  comment(input: {
    readonly owner: string;
    readonly repo: string;
    readonly issue: number;
    readonly body: string;
  }): Promise<void>;
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
          title: input.title ?? (input.conclusion === "success" ? "Passed" : "Failed"),
          summary: input.summary,
        },
      });
    },
    async comment(input) {
      await octokit.issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issue,
        body: input.body,
      });
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
