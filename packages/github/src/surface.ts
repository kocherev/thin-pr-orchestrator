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
    getCommit(params: {
      readonly owner: string;
      readonly repo: string;
      readonly commit_sha: string;
    }): Promise<{ data: { tree: { sha: string } } }>;
    createBlob(params: {
      readonly owner: string;
      readonly repo: string;
      readonly content: string;
      readonly encoding: "utf-8";
    }): Promise<{ data: { sha: string } }>;
    createTree(params: {
      readonly owner: string;
      readonly repo: string;
      readonly base_tree: string;
      readonly tree: {
        path: string;
        mode: "100644";
        type: "blob";
        sha: string;
      }[];
    }): Promise<{ data: { sha: string } }>;
    createCommit(params: {
      readonly owner: string;
      readonly repo: string;
      readonly message: string;
      readonly tree: string;
      readonly parents: string[];
    }): Promise<{ data: { sha: string } }>;
    updateRef(params: {
      readonly owner: string;
      readonly repo: string;
      readonly ref: string;
      readonly sha: string;
    }): Promise<unknown>;
  };
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
  repos: {
    getContent(params: {
      readonly owner: string;
      readonly repo: string;
      readonly path: string;
      readonly ref: string;
    }): Promise<{
      data:
        | { readonly type: string; readonly content?: string; readonly encoding?: string }
        | readonly unknown[];
    }>;
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
    readonly title?: string;
  }): Promise<void>;
  comment(input: {
    readonly owner: string;
    readonly repo: string;
    readonly issue: number;
    readonly body: string;
  }): Promise<void>;
  readText(input: {
    readonly owner: string;
    readonly repo: string;
    readonly ref: string;
    readonly path: string;
  }): Promise<string | null>;
  commitFiles(input: {
    readonly owner: string;
    readonly repo: string;
    readonly branch: string;
    readonly parentSha: string;
    readonly message: string;
    readonly files: readonly { readonly path: string; readonly content: string }[];
  }): Promise<string>;
  openDraft(input: {
    readonly owner: string;
    readonly repo: string;
    readonly title: string;
    readonly head: string;
    readonly base: string;
    readonly body: string;
    readonly draft: true;
  }): Promise<{ readonly number: number; readonly url: string }>;
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
    async readText(input) {
      try {
        const { data } = await octokit.repos.getContent({
          owner: input.owner,
          repo: input.repo,
          path: input.path,
          ref: input.ref,
        });
        if (!isFileContent(data) || data.encoding !== "base64") {
          return null;
        }
        return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    async commitFiles(input) {
      if (input.files.length === 0) {
        throw new Error("commit has no files");
      }
      const { data: parent } = await octokit.git.getCommit({
        owner: input.owner,
        repo: input.repo,
        commit_sha: input.parentSha,
      });
      const baseTree = parent.tree.sha;
      if (baseTree.length === 0) {
        throw new Error(`commit ${input.parentSha} has no tree`);
      }
      const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
      for (const file of input.files) {
        const { data: blob } = await octokit.git.createBlob({
          owner: input.owner,
          repo: input.repo,
          content: file.content,
          encoding: "utf-8",
        });
        tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
      }
      const { data: nextTree } = await octokit.git.createTree({
        owner: input.owner,
        repo: input.repo,
        base_tree: baseTree,
        tree,
      });
      const { data: commit } = await octokit.git.createCommit({
        owner: input.owner,
        repo: input.repo,
        message: input.message,
        tree: nextTree.sha,
        parents: [input.parentSha],
      });
      await octokit.git.updateRef({
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${input.branch}`,
        sha: commit.sha,
      });
      return commit.sha;
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

function isFileContent(
  data: { readonly type: string; readonly content?: string; readonly encoding?: string } | readonly unknown[],
): data is { readonly type: "file"; readonly content: string; readonly encoding?: string } {
  if (typeof data !== "object" || data === null || !("type" in data) || !("content" in data)) {
    return false;
  }
  return data.type === "file" && typeof data.content === "string";
}
