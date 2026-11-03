import { formatDuration } from "@/lib/format";
import type { CheckResult } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { FailIcon, PassIcon } from "./icons";
import { LogDetails } from "./log-details";

export function CheckResults({ checks }: { checks: readonly CheckResult[] }) {
  return (
    <ul className="divide-y divide-border">
      {checks.map((check) => {
        const pass = check.exitCode === 0;
        const Icon = pass ? PassIcon : FailIcon;
        return (
          <li key={check.name} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex gap-3">
              <Icon strokeWidth={2} className={cn("mt-0.5 shrink-0", pass ? "text-success" : "text-danger")} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono font-medium">{check.name}</span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    <span className={pass ? "text-success" : "text-danger"}>exit {check.exitCode}</span> ·{" "}
                    {formatDuration(check.durationMs)}
                  </span>
                </div>
                <code className="truncate font-mono text-xs text-muted-foreground">{check.command}</code>
              </div>
            </div>
            <LogDetails label="Log tail" text={check.logTail} open={!pass} className="ml-7" />
          </li>
        );
      })}
    </ul>
  );
}
