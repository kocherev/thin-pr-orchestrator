export type GitHubRest = {
  git: {
    getRef(params: {
      readonly owner: string;
      readonly repo: string;
      readonly ref: string;
    }): Promise<{ data: { object: { sha: string; type: string } } }>;
    createRef(params: {
      readonly owner: string;
      readonly repo: string;
      readonly ref: string;
      readonly sha: string;
    }): Promise<unknown>;
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

export type GitHubSurface = {
  branchSha(owner: string, repo: string, branch: string): Promise<string>;
  createBranch(owner: string, repo: string, branch: string, sha: string): Promise<void>;
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
  }): Promise<void>;
  comment(input: {
    readonly owner: string;
    readonly repo: string;
    readonly issue: number;
    readonly body: string;
  }): Promise<void>;
};

export function createGitHubSurface(octokit: GitHubRest): GitHubSurface {
  return {
    async branchSha(owner, repo, branch) {
      const { data } = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      if (data.object.type !== "commit") {
        throw new Error(`ref heads/${branch} is not a commit`);
      }
      return data.object.sha;
    },
    async createBranch(owner, repo, branch, sha) {
      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha,
      });
    },
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
          title: input.conclusion === "success" ? "Passed" : "Failed",
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
  };
}
