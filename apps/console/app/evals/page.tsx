import type { Metadata } from "next";
import Link from "next/link";
import { FailIcon, PassIcon } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Section } from "@/components/section";
import { StatStrip } from "@/components/stat-strip";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getEvalReport, getRun } from "@/lib/data";
import { summarizeEvals } from "@/lib/evals";
import { formatDate, formatDuration, formatPercent, formatUsd } from "@/lib/format";
import { REPLAY_NOTE } from "@/lib/run";
import type { RunStatus } from "@/lib/schema";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Evals" };

function VerdictText({ verdict }: { verdict: RunStatus }) {
  return <span className="font-mono">{verdict}</span>;
}

export default function EvalsPage() {
  const report = getEvalReport();
  if (!report || report.cases.length === 0) {
    return (
      <>
        <PageHeader title="Evals" />
        <div className="rounded-xl bg-surface shadow-border">
          <EmptyState title="No eval report">
            Run <code className="font-mono text-foreground">pnpm eval -- --write</code> to write{" "}
            <code className="font-mono text-foreground">evals/report.json</code>, then rebuild the console.
          </EmptyState>
        </div>
      </>
    );
  }

  const summary = summarizeEvals(report);

  return (
    <>
      <PageHeader
        title="Evals"
        description={
          <>
            <p>
              Each case runs a labeled issue against the sample repo and compares the run status with the expected one.
              Recorded {formatDate(report.generatedAt)}.
            </p>
            <p>{REPLAY_NOTE}</p>
          </>
        }
      />
      <StatStrip
        label="Eval summary"
        stats={[
          {
            label: "Verdict accuracy",
            value: formatPercent(summary.matched, summary.total),
            detail: `${summary.matched} of ${summary.total} cases match`,
          },
          {
            label: "Resolve rate",
            value: formatPercent(summary.resolved, summary.shouldOpen),
            detail: `${summary.resolved} of ${summary.shouldOpen} cases that should open`,
          },
          {
            label: "Cost per resolved",
            value: summary.costPerResolvedUsd === null ? "n/a" : formatUsd(summary.costPerResolvedUsd),
            detail: "spend on those cases / opened",
          },
          { label: "Total cost", value: formatUsd(summary.totalCostUsd), detail: `${summary.total} cases` },
        ]}
      />
      <Section id="cases" title="Cases" meta={`${summary.total - summary.matched} mismatched`}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Case</TableHead>
              <TableHead className="hidden sm:table-cell">Expected</TableHead>
              <TableHead className="hidden sm:table-cell">Actual</TableHead>
              <TableHead>Match</TableHead>
              <TableHead className="hidden sm:table-cell">Rules failed</TableHead>
              <TableHead className="hidden md:table-cell">Models</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.cases.map((evalCase) => {
              const match = evalCase.expected === evalCase.actual;
              return (
                <TableRow key={evalCase.caseId} className={cn(!match && "bg-danger/6")}>
                  <TableCell className="max-w-0 min-w-36 whitespace-normal sm:min-w-52">
                    {getRun(`eval-${evalCase.caseId}`) ? (
                      <Link
                        href={`/runs/eval-${evalCase.caseId}`}
                        className="block font-medium text-pretty underline-offset-2 hover:underline sm:truncate"
                      >
                        {evalCase.title}
                      </Link>
                    ) : (
                      <span className="block font-medium text-pretty sm:truncate">{evalCase.title}</span>
                    )}
                    <span className="block truncate font-mono text-xs text-muted-foreground">{evalCase.caseId}</span>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <VerdictText verdict={evalCase.expected} />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <VerdictText verdict={evalCase.actual} />
                  </TableCell>
                  <TableCell>
                    {match ? (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <PassIcon strokeWidth={2} className="text-success" /> Match
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 font-medium text-danger">
                        <FailIcon strokeWidth={2} /> Mismatch
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {evalCase.failedRules.length > 0 ? (
                      <span className="flex gap-1">
                        {evalCase.failedRules.map((rule) => (
                          <Badge key={rule} tone="neutral" className="font-mono">
                            {rule}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                    {evalCase.models.map((model) => model.replace(/^claude-/, "")).join(", ")}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatUsd(evalCase.costUsd)}</TableCell>
                  <TableCell className="hidden text-right font-mono text-muted-foreground tabular-nums sm:table-cell">
                    {formatDuration(evalCase.durationMs)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Section>
    </>
  );
}
