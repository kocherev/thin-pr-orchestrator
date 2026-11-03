import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckResults } from "@/components/check-results";
import { DiffSummary, DiffViewer } from "@/components/diff-viewer";
import { GateChecks } from "@/components/gate-checks";
import { ChevronIcon, ExternalIcon } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { RunOutcome } from "@/components/run-outcome";
import { EmptyState, Section } from "@/components/section";
import { StatStrip, type Stat } from "@/components/stat-strip";
import { StatusPill } from "@/components/status-pill";
import { StepTimeline } from "@/components/step-timeline";
import { buttonVariants } from "@/components/ui/button";
import { getRun, getRuns } from "@/lib/data";
import { formatDate, formatDuration, formatTokens, formatUsd } from "@/lib/format";
import { gateSummary, isReplay, REPLAY_NOTE, runStartedAt } from "@/lib/run";
import type { RunRecord } from "@/lib/schema";

type Props = { params: Promise<{ runId: string }> };

export const dynamicParams = false;

export function generateStaticParams(): { runId: string }[] {
  const runs = getRuns();
  // output: "export" rejects an empty list, so a build with no runs renders one not-found page instead.
  return runs.length > 0 ? runs.map((run) => ({ runId: run.runId })) : [{ runId: "none" }];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const run = getRun((await params).runId);
  return { title: run ? run.issue.title : "Run not found" };
}

const externalLink = "inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline";

function PullRequest({ pullRequest, replay }: { pullRequest: NonNullable<RunRecord["pullRequest"]>; replay: boolean }) {
  if (replay) return <span className="text-xs text-muted-foreground">Draft opened in the replay</span>;
  return (
    <a href={pullRequest.url} className={buttonVariants({ variant: "outline", size: "sm" })}>
      Draft PR #{pullRequest.number}
      <ExternalIcon />
    </a>
  );
}

function gateStat(run: RunRecord): Stat {
  const { passed, total } = gateSummary(run);
  if (total === 0) return { label: "Gate", value: "Did not run", detail: "the run stopped first" };
  const waiting = run.gate.filter((result) => result.verdict === "NEEDS_APPROVAL").length;
  const failed = total - passed - waiting;
  const detail = [failed > 0 ? `${failed} failed` : null, waiting > 0 ? `${waiting} needs approval` : null].filter(Boolean);
  return { label: "Gate", value: `${passed}/${total}`, detail: detail.length > 0 ? detail.join(", ") : "every rule passed" };
}

export default async function RunPage({ params }: Props) {
  const run = getRun((await params).runId);
  if (!run) notFound();

  const gate = gateSummary(run);
  const startedAt = runStartedAt(run);
  const replay = isReplay(run);
  const sentBack = run.steps.filter((step) => step.outcome === "looped").length;

  return (
    <>
      <nav aria-label="Breadcrumb" className="-mb-3 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <Link href="/" className="rounded-sm transition-[color] duration-150 ease-out hover:text-foreground">
          Runs
        </Link>
        <ChevronIcon className="size-3 shrink-0" />
        <span aria-current="page" className="truncate font-mono">
          {run.runId}
        </span>
      </nav>

      <PageHeader
        title={run.issue.title}
        description={
          <>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <StatusPill status={run.status} />
              {replay ? (
                <span className="font-mono text-xs">
                  {run.repo}#{run.issue.number}
                </span>
              ) : (
                <a href={run.issue.url} className={`${externalLink} font-mono text-xs`}>
                  {run.repo}#{run.issue.number}
                  <ExternalIcon className="size-3" />
                </a>
              )}
              <span className="text-xs">
                <span className="font-mono">{run.template}</span> template
              </span>
              {startedAt ? <span className="text-xs">{formatDate(startedAt)}</span> : null}
            </span>
            {replay ? <p className="mt-2 text-xs">{REPLAY_NOTE}</p> : null}
          </>
        }
        actions={run.pullRequest ? <PullRequest pullRequest={run.pullRequest} replay={replay} /> : undefined}
      />

      <RunOutcome run={run} />

      <StatStrip
        label="Run totals"
        stats={[
          gateStat(run),
          {
            label: "Duration",
            value: formatDuration(run.totals.durationMs),
            detail: `${run.steps.length} steps${sentBack > 0 ? `, ${sentBack} sent back` : ""}`,
          },
          { label: "Cost", value: formatUsd(run.totals.costUsd), detail: "model spend" },
          {
            label: "Tokens",
            value: formatTokens(run.totals.inputTokens + run.totals.outputTokens),
            detail: `${formatTokens(run.totals.inputTokens)} in / ${formatTokens(run.totals.outputTokens)} out`,
          },
        ]}
      />

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <Section id="gate" title="Gate rules" meta={gate.total > 0 ? `${gate.passed} of ${gate.total} passed` : undefined}>
          {gate.total > 0 ? (
            <GateChecks results={run.gate} />
          ) : (
            <EmptyState title="The gate did not run">The run stopped before it had a change to check.</EmptyState>
          )}
        </Section>
        <Section id="checks" title="Checks">
          {run.checks.length > 0 ? (
            <CheckResults checks={run.checks} />
          ) : (
            <EmptyState title="No checks ran">Typecheck and tests run after the implement step, which this run never reached.</EmptyState>
          )}
        </Section>
      </div>

      <Section id="steps" title="Steps" meta="Bars share one clock from the first step">
        {run.steps.length > 0 ? <StepTimeline run={run} /> : <EmptyState title="No steps recorded" />}
      </Section>

      <Section id="diff" title="Diff" meta={run.diff && run.diff.files.length > 0 ? <DiffSummary diff={run.diff} /> : undefined}>
        {run.diff ? (
          <DiffViewer diff={run.diff} />
        ) : (
          <EmptyState title="No diff recorded">The implement step did not leave a change to measure.</EmptyState>
        )}
      </Section>
    </>
  );
}
