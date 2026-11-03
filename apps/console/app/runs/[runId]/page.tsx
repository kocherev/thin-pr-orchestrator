import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckResults } from "@/components/check-results";
import { DiffSummary, DiffViewer } from "@/components/diff-viewer";
import { GateChecks } from "@/components/gate-checks";
import { ChevronIcon, ExternalIcon } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Section } from "@/components/section";
import { StatStrip } from "@/components/stat-strip";
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

function PullRequest({ run, replay }: { run: RunRecord; replay: boolean }) {
  if (!run.pullRequest) return <span className="text-xs text-muted-foreground">No pull request</span>;
  if (replay) return <span className="text-xs text-muted-foreground">Draft opened in the replay</span>;
  return (
    <a href={run.pullRequest.url} className={buttonVariants({ variant: "outline", size: "sm" })}>
      Draft PR #{run.pullRequest.number}
      <ExternalIcon />
    </a>
  );
}

export default async function RunPage({ params }: Props) {
  const run = getRun((await params).runId);
  if (!run) notFound();

  const gate = gateSummary(run);
  const startedAt = runStartedAt(run);
  const replay = isReplay(run);

  return (
    <>
      <nav aria-label="Breadcrumb" className="-mb-2 flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/" className="rounded-sm hover:text-foreground">
          Runs
        </Link>
        <ChevronIcon className="size-3" />
        <span aria-current="page" className="font-mono">
          {run.runId}
        </span>
      </nav>

      <PageHeader
        title={run.issue.title}
        description={
          <>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {replay ? (
                <span className="font-mono">
                  {run.repo}#{run.issue.number}
                </span>
              ) : (
                <a href={run.issue.url} className={`${externalLink} font-mono`}>
                  {run.repo}#{run.issue.number}
                  <ExternalIcon className="size-3" />
                </a>
              )}
              <span className="font-mono">{run.template}</span>
              {startedAt ? <span>{formatDate(startedAt)}</span> : null}
            </span>
            {replay ? <p className="mt-1">{REPLAY_NOTE}</p> : null}
          </>
        }
        actions={
          <>
            <StatusPill status={run.status} />
            <PullRequest run={run} replay={replay} />
          </>
        }
      />

      <StatStrip
        label="Run totals"
        stats={[
          { label: "Cost", value: formatUsd(run.totals.costUsd) },
          { label: "Duration", value: formatDuration(run.totals.durationMs), detail: `${run.steps.length} step attempts` },
          {
            label: "Tokens",
            value: formatTokens(run.totals.inputTokens + run.totals.outputTokens),
            detail: `${formatTokens(run.totals.inputTokens)} in / ${formatTokens(run.totals.outputTokens)} out`,
          },
          {
            label: "Gate",
            value: gate.total === 0 ? "Not run" : `${gate.passed}/${gate.total}`,
            detail: gate.total === 0 ? "the run stopped first" : `${gate.total - gate.passed} failed`,
          },
        ]}
      />

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <Section id="gate" title="Gate" meta={gate.total > 0 ? `${gate.passed} of ${gate.total} rules passed` : undefined}>
          {gate.total > 0 ? (
            <GateChecks results={run.gate} />
          ) : (
            <EmptyState title="The gate did not run">The run failed before the write step finished.</EmptyState>
          )}
        </Section>
        <Section id="checks" title="Checks">
          {run.checks.length > 0 ? (
            <CheckResults checks={run.checks} />
          ) : (
            <EmptyState title="No checks ran">The verify step never ran for this run.</EmptyState>
          )}
        </Section>
      </div>

      <Section id="steps" title="Steps" meta="One time axis from the first step">
        {run.steps.length > 0 ? <StepTimeline run={run} /> : <EmptyState title="No steps recorded" />}
      </Section>

      <Section id="diff" title="Diff" meta={run.diff ? <DiffSummary diff={run.diff} /> : undefined}>
        {run.diff ? (
          <DiffViewer diff={run.diff} />
        ) : (
          <EmptyState title="No diff recorded">The implement step did not leave a change to measure.</EmptyState>
        )}
      </Section>
    </>
  );
}
