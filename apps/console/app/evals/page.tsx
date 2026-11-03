import type { Metadata } from "next";
import Link from "next/link";
import { FailIcon, PassIcon } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Section } from "@/components/section";
import { StatStrip } from "@/components/stat-strip";
import { StatusText } from "@/components/status-pill";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getEvalReport, getExpected, getRun } from "@/lib/data";
import { isCorrect, summarizeEvals } from "@/lib/evals";
import { ruleLabel } from "@/lib/labels";
import { formatDate, formatDuration, formatPercent, formatUsd } from "@/lib/format";
import { REPLAY_NOTE } from "@/lib/run";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Evals" };

export default function EvalsPage() {
  const report = getEvalReport();
  if (!report || report.cases.length === 0) {
    return (
      <>
        <PageHeader title="Evals" />
        <div className="rounded-xl bg-surface shadow-border">
          <EmptyState title="No eval report yet">
            The eval suite scores every labeled case. Run{" "}
            <code className="font-mono text-foreground">pnpm eval -- --write</code> to record{" "}
            <code className="font-mono text-foreground">evals/report.json</code>, then{" "}
            <code className="font-mono text-foreground">pnpm console:build</code>.
          </EmptyState>
        </div>
      </>
    );
  }

  const expected = getExpected();
  const summary = summarizeEvals(report, expected);

  return (
    <>
      <PageHeader
        title="Evals"
        description={
          <>
            <p className="max-w-[68ch]">
              Each case is an issue with a known right answer: open a pull request, wait for approval or stop. The suite
              runs every case and checks the run ended as labeled. A run that failed before the gate counts as
              blocked. Recorded {formatDate(report.generatedAt)}.
            </p>
            <p className="mt-2 text-xs">{REPLAY_NOTE}</p>
          </>
        }
      />
      <StatStrip
        label="Eval summary"
        stats={[
          {
            label: "Verdict accuracy",
            value: formatPercent(summary.correct, summary.total),
            detail: `${summary.correct} of ${summary.total} cases ended as labeled`,
            tone: summary.correct === summary.total ? "text-success" : "text-danger",
          },
          {
            label: "Resolve rate",
            value: formatPercent(summary.resolved, summary.shouldOpen),
            detail: `${summary.resolved} of ${summary.shouldOpen} cases that should open did`,
          },
          {
            label: "Cost per resolved",
            value: summary.costPerResolvedUsd === null ? "n/a" : formatUsd(summary.costPerResolvedUsd),
            detail: "spend on cases that should open, per one that did",
          },
          { label: "Total cost", value: formatUsd(summary.totalCostUsd), detail: `${summary.total} cases` },
        ]}
      />
      <Section
        id="cases"
        title="Cases"
        meta={summary.correct === summary.total ? "Every case matches" : `${summary.total - summary.correct} mismatched`}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Case</TableHead>
              <TableHead className="hidden md:table-cell">Expected</TableHead>
              <TableHead className="hidden md:table-cell">Actual</TableHead>
              <TableHead>Match</TableHead>
              <TableHead className="hidden lg:table-cell">Rules failed</TableHead>
              <TableHead className="hidden xl:table-cell">Models</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Cost</TableHead>
              <TableHead className="hidden text-right lg:table-cell">Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.cases.map((evalCase) => {
              const match = isCorrect(evalCase, expected.get(evalCase.caseId));
              return (
                <TableRow key={evalCase.caseId} className={cn(!match && "bg-danger/6")}>
                  <TableCell className="max-w-0 min-w-36 whitespace-normal sm:min-w-52">
                    {getRun(`eval-${evalCase.caseId}`) ? (
                      <Link
                        href={`/runs/eval-${evalCase.caseId}`}
                        className="block font-medium text-pretty underline-offset-2 hover:underline"
                      >
                        {evalCase.title}
                      </Link>
                    ) : (
                      <span className="block font-medium text-pretty">{evalCase.title}</span>
                    )}
                    <span className="block font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground">{evalCase.caseId}</span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <StatusText status={evalCase.expected} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <StatusText status={evalCase.actual} />
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
                  <TableCell className="hidden lg:table-cell">
                    {evalCase.failedRules.length > 0 ? (
                      <span className="flex gap-1">
                        {evalCase.failedRules.map((rule) => (
                          <Badge key={rule} tone="neutral">
                            {ruleLabel(rule)}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground xl:table-cell">
                    {evalCase.models.map((model) => model.replace(/^claude-/, "")).join(", ")}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">{formatUsd(evalCase.costUsd)}</TableCell>
                  <TableCell className="hidden text-right text-muted-foreground tabular-nums lg:table-cell">
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
