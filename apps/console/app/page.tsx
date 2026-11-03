import { PageHeader } from "@/components/page-header";
import { RunsTable, type RunRow } from "@/components/runs-table";
import { EmptyState } from "@/components/section";
import { StatStrip } from "@/components/stat-strip";
import { getRuns } from "@/lib/data";
import { formatDate, formatDuration, formatUsd } from "@/lib/format";
import { gateSummary, isReplay, REPLAY_NOTE, runStartedAt } from "@/lib/run";
import type { RunRecord } from "@/lib/schema";

function toRow(run: RunRecord): RunRow {
  const gate = gateSummary(run);
  const startedAt = runStartedAt(run);
  return {
    runId: run.runId,
    repo: run.repo,
    issueNumber: run.issue.number,
    issueTitle: run.issue.title,
    template: run.template,
    status: run.status,
    gatePassed: gate.passed,
    gateTotal: gate.total,
    cost: formatUsd(run.totals.costUsd),
    duration: formatDuration(run.totals.durationMs),
    startedAt: startedAt ? formatDate(startedAt) : "Not started",
  };
}

export default function RunsPage() {
  const runs = getRuns();
  const count = (status: RunRecord["status"]) => runs.filter((run) => run.status === status).length;
  const totalCost = runs.reduce((sum, run) => sum + run.totals.costUsd, 0);

  return (
    <>
      <PageHeader
        title="Runs"
        description={
          <>
            <p>
              Each run takes one labeled issue through plan, implement, verify, review and write, then the gate decides
              whether a draft pull request opens.
            </p>
            {runs.some(isReplay) ? <p>{REPLAY_NOTE}</p> : null}
          </>
        }
      />
      {runs.length === 0 ? (
        <div className="rounded-xl bg-surface shadow-border">
          <EmptyState title="No runs yet">
            Export RunRecords as JSON into <code className="font-mono text-foreground">apps/console/data/runs/</code> and
            rebuild the console.
          </EmptyState>
        </div>
      ) : (
        <>
          <StatStrip
            label="Run summary"
            stats={[
              { label: "Runs", value: runs.length },
              { label: "Opened", value: count("opened"), detail: "draft pull requests" },
              { label: "Blocked", value: count("blocked"), detail: `${count("failed")} failed before the gate` },
              { label: "Total cost", value: formatUsd(totalCost), detail: `${formatUsd(totalCost / runs.length)} per run` },
            ]}
          />
          <RunsTable rows={runs.map(toRow)} />
        </>
      )}
    </>
  );
}
