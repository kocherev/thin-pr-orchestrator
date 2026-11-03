import type { CSSProperties } from "react";
import { formatDuration, formatTokens, formatUsd } from "@/lib/format";
import { STEP_LABEL } from "@/lib/labels";
import { firstLine, stepUsage, timeline, type TimelineRow } from "@/lib/run";
import type { RunRecord } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { LogDetails } from "./log-details";
import { Badge } from "./ui/badge";

const columns = "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[10rem_minmax(0,1fr)_4.5rem]";

/** The bars replay the run on one clock this long, so their growth keeps the real proportions. */
const REPLAY_MS = 900;
const REPLAY_START_MS = 250;

function barStyle({ offset, width }: TimelineRow): CSSProperties {
  return {
    left: `${offset * 100}%`,
    width: `${width * 100}%`,
    "--delay": `${REPLAY_START_MS + offset * REPLAY_MS}ms`,
    "--duration": `${Math.max(width * REPLAY_MS, 60)}ms`,
  } as CSSProperties;
}

function barColor({ step }: TimelineRow): string {
  if (step.outcome === "failed") return "bg-danger";
  if (step.outcome === "looped") return "bg-warning";
  return step.usage.length > 0 ? "bg-primary" : "bg-muted-foreground/50";
}

function StepMeta({ row }: { row: TimelineRow }) {
  const usage = stepUsage(row.step);
  if (usage.requests === 0) return <span>No model call</span>;
  return (
    <>
      <span className="text-foreground">{usage.models.join(", ")}</span>
      <span>
        {usage.requests} {usage.requests === 1 ? "request" : "requests"}
      </span>
      <span>
        {formatTokens(usage.inputTokens)} in / {formatTokens(usage.outputTokens)} out
      </span>
      <span>{formatUsd(usage.costUsd)}</span>
    </>
  );
}

export function StepTimeline({ run }: { run: RunRecord }) {
  const { spanMs, rows } = timeline(run);
  return (
    <div className="flex flex-col">
      <div
        aria-hidden="true"
        className={cn("hidden gap-4 border-b border-border px-4 py-2 text-xs text-muted-foreground sm:grid", columns)}
      >
        <span>Step</span>
        <span className="flex justify-between tabular-nums">
          <span>0s</span>
          <span>{formatDuration(spanMs / 2)}</span>
          <span>{formatDuration(spanMs)}</span>
        </span>
        <span className="text-right">Took</span>
      </div>
      <ol className="divide-y divide-border">
        {rows.map((row) => (
          <li
            key={`${row.step.id}-${row.step.loop}-${row.step.attempt}`}
            className={cn("grid gap-x-4 gap-y-1.5 px-4 py-3", columns)}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{STEP_LABEL[row.step.id]}</span>
              {row.step.loop > 0 ? <Badge tone="neutral">round {row.step.loop + 1}</Badge> : null}
              {row.step.attempt > 1 ? <Badge tone="neutral">attempt {row.step.attempt}</Badge> : null}
            </div>
            <div className="relative col-span-2 h-2 self-center rounded-full bg-muted sm:col-span-1" aria-hidden="true">
              <div className={cn("bar-grow absolute inset-y-0 min-w-1 rounded-full", barColor(row))} style={barStyle(row)} />
            </div>
            <div className="col-start-2 row-start-1 self-center text-right text-xs text-muted-foreground tabular-nums sm:col-start-3">
              {formatDuration(row.step.durationMs)}
            </div>
            <div className="col-span-2 flex flex-col gap-1 sm:col-start-2 sm:col-end-4">
              <p className="text-pretty">
                {row.step.outcome === "failed" ? (
                  <Badge tone="danger" className="mr-1.5">
                    Failed
                  </Badge>
                ) : null}
                {row.step.outcome === "looped" ? (
                  <Badge tone="warning" className="mr-1.5">
                    Sent back
                  </Badge>
                ) : null}
                {firstLine(row.step.summary)}
              </p>
              {row.step.summary.includes("\n") ? <LogDetails label="Feedback sent back" text={row.step.summary} /> : null}
              <p className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs text-muted-foreground tabular-nums">
                <StepMeta row={row} />
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
