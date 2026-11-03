import { PageHeader } from "@/components/page-header";
import { RunsTable, type RunRow } from "@/components/runs-table";
import { EmptyState } from "@/components/section";
import { StatStrip } from "@/components/stat-strip";
import { getRuns } from "@/lib/data";
import { formatDate, formatDuration, formatUsd } from "@/lib/format";
import { isReplay, REPLAY_NOTE, runOutcome, runStartedAt } from "@/lib/run";
import type { RunRecord } from "@/lib/schema";

function toRow(run: RunRecord): RunRow {
  const startedAt = runStartedAt(run);
  return {
    runId: run.runId,
    repo: run.repo,
    issueNumber: run.issue.number,
    issueTitle: run.issue.title,
    status: run.status,
    outcome: runOutcome(run).short,
    cost: formatUsd(run.totals.costUsd),
    duration: formatDuration(run.totals.durationMs),
    startedAt: startedAt ? formatDate(startedAt) : "Not started",
  };
}

export default function RunsPage() {
  const runs = getRuns();
  const count = (status: RunRecord["status"]) => runs.filter((run) => run.status === status).length;
  const totalCost = runs.reduce((sum, run) => sum + run.totals.costUsd, 0);
  const waiting = count("awaiting_approval");

  return (
    <>
      <PageHeader
        title="Runs"
        description={
          <>
            <p className="max-w-[68ch]">
              A run is one attempt to turn a labeled GitHub issue into a small draft pull request. Agents plan, edit and
              test the change, then nine gate rules decide whether the pull request opens. Pick a run to see why it
              passed or stopped.
            </p>
            {runs.some(isReplay) ? <p className="mt-2 text-xs">{REPLAY_NOTE}</p> : null}
          </>
        }
      />
      {runs.length === 0 ? (
        <div className="rounded-xl bg-surface shadow-border">
          <EmptyState title="No runs yet">
            Runs show up here after the next build. Record the eval runs with{" "}
            <code className="font-mono text-foreground">pnpm eval -- --write</code>, or export live runs as JSON into{" "}
            <code className="font-mono text-foreground">apps/console/data/runs/</code>, then run{" "}
            <code className="font-mono text-foreground">pnpm console:build</code>.
          </EmptyState>
        </div>
      ) : (
        <>
          <StatStrip
            label="Run summary"
            stats={[
              {
                label: "Opened",
                value: count("opened"),
                detail: `draft pull requests from ${runs.length} runs`,
                tone: "text-success",
              },
              {
                label: "Needs approval",
                value: waiting,
                detail: waiting > 0 ? "over the size budget, waiting on you" : "nothing waiting",
                tone: waiting > 0 ? "text-primary" : undefined,
              },
              {
                label: "Stopped",
                value: count("blocked") + count("failed"),
                detail: `${count("blocked")} blocked by the gate, ${count("failed")} failed`,
              },
              { label: "Total cost", value: formatUsd(totalCost), detail: `${formatUsd(totalCost / runs.length)} per run` },
            ]}
          />
          <RunsTable rows={runs.map(toRow)} />
        </>
      )}
    </>
  );
}
