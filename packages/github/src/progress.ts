import type { RunEvent, StepId } from "@thin-pr/core";
import { usd } from "./report.js";
import type { GitHubSurface } from "./surface.js";

// Every body of a run's comment ends with this, so a command can find the latest run on an issue.
const RUN_COMMENT = "<!-- thin-pr-run-comment -->";

/** True for a run's progress comment or report. Check the author too: anyone can type the marker. */
export function isRunComment(body: string): boolean {
  return body.endsWith(RUN_COMMENT);
}

type Row ={ status: "pending" | "running" | "done" | "looped" | "failed"; attempt: number; loop: number; costUsd: number };

/** The comment a run creates when it starts and edits as each step moves on. Its last body is the run report. */
export type Progress = {
  /** Updates the checklist for one run event. Run-level events change nothing. */
  onEvent(event: RunEvent): Promise<void>;
  /** Marks the gate as running. */
  gating(): Promise<void>;
  /** Replaces the checklist with the final body. */
  finish(body: string): Promise<void>;
};

export async function startProgress(input: {
  readonly github: GitHubSurface;
  readonly owner: string;
  readonly repo: string;
  /** The issue or pull request number the comment goes on. */
  readonly issue: number;
  /** The first line, such as "Running the feature template on #7." */
  readonly title: string;
  readonly steps: readonly StepId[];
  readonly runId: string;
  /** Markdown that links to where the run executes: the Actions run, or the App delivery. */
  readonly runLink: string | null;
}): Promise<Progress> {
  const rows = new Map<StepId, Row>(input.steps.map((step) => [step, { status: "pending", attempt: 0, loop: 0, costUsd: 0 }]));
  const passes: Partial<Record<StepId, number>> = {};
  let gate: Row["status"] = "pending";

  const render = (): string => {
    const total = [...rows.values()].reduce((sum, row) => sum + row.costUsd, 0);
    const where = input.runLink ? `, ${input.runLink}` : "";
    const table = [...rows].map(
      ([step, row]) => `| ${step} | ${row.status} | ${row.attempt || ""} | ${row.attempt ? row.loop : ""} | ${usd(row.costUsd)} |`,
    );
    return [
      `**${input.title}** Run \`${input.runId}\`${where}. Cost so far: ${usd(total)}.`,
      ["| Step | Status | Attempt | Loop | Cost |", "| --- | --- | --- | --- | --- |", ...table, `| gate | ${gate} | | | |`].join("\n"),
      "This comment updates as the run moves on, and ends as the run report.",
    ].join("\n\n");
  };

  const target = { owner: input.owner, repo: input.repo };
  const commentId = await input.github.createComment({ ...target, issue: input.issue, body: `${render()}\n\n${RUN_COMMENT}` });
  const edit = (body: string) => input.github.editComment({ ...target, commentId, body: `${body}\n\n${RUN_COMMENT}` });

  return {
    async onEvent(event) {
      const row = event.step === null ? undefined : rows.get(event.step);
      if (!row || !event.step || event.kind === "completed") {
        return;
      }
      row.costUsd += event.usage.reduce((sum, call) => sum + call.costUsd, 0);
      if (event.kind === "started") {
        if (event.attempt === 1) {
          passes[event.step] = (passes[event.step] ?? -1) + 1;
        }
        Object.assign(row, { status: "running", attempt: event.attempt, loop: passes[event.step] ?? 0 });
      } else {
        row.status = event.kind === "finished" ? "done" : event.kind;
      }
      await edit(render());
    },
    async gating() {
      gate = "running";
      await edit(render());
    },
    finish: edit,
  };
}
