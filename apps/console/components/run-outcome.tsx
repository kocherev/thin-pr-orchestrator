import { APPROVE_COMMAND, runOutcome } from "@/lib/run";
import type { RunRecord } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";
import { ArrowIcon } from "./icons";
import { STATUS_STYLE } from "./status-pill";

const SURFACE: Record<RunRecord["status"], string> = {
  opened: "bg-success/6",
  awaiting_approval: "bg-primary/8",
  blocked: "bg-warning/8",
  failed: "bg-danger/6",
  cancelled: "bg-muted",
};

/** The answer to "why did this run end this way", above the evidence for it. */
export function RunOutcome({ run }: { run: RunRecord }) {
  const outcome = runOutcome(run);
  const { Icon, text } = STATUS_STYLE[run.status];
  const evidence = run.status === "failed" ? { href: "#steps", label: "See the steps" } : { href: "#gate", label: "See every gate rule" };

  return (
    <section aria-labelledby="outcome" className={cn("flex gap-3 rounded-xl px-4 py-3.5 shadow-border", SURFACE[run.status])}>
      <Icon strokeWidth={2} className={cn("mt-0.5 size-5 shrink-0", text)} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 id="outcome" className="font-medium text-pretty">
          {outcome.headline}
        </h2>
        {outcome.detail ? <p className="text-pretty text-muted-foreground">{outcome.detail}</p> : null}
        {run.status === "awaiting_approval" ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-medium">
            Approve with
            <span className="inline-flex items-center rounded-md bg-surface py-0.5 pr-0.5 pl-2 shadow-border">
              <code className="font-mono text-xs">{APPROVE_COMMAND}</code>
              <CopyButton text={APPROVE_COMMAND} label="Copy the approve command" />
            </span>
            on the issue.
          </div>
        ) : null}
        <a
          href={evidence.href}
          className="group mt-1 inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-2 transition-[color] duration-150 ease-out hover:text-foreground hover:underline"
        >
          {evidence.label}
          <ArrowIcon className="size-3.5 rotate-90 transition-[translate] duration-150 ease-out motion-safe:group-hover:translate-y-0.5" />
        </a>
      </div>
    </section>
  );
}
