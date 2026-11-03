import type { GateRuleResult } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { BlockedIcon, FailIcon, PassIcon } from "./icons";

const VERDICT = {
  PASS: { Icon: PassIcon, text: "text-success", row: "" },
  FAIL: { Icon: FailIcon, text: "text-danger", row: "bg-danger/6" },
  NEEDS_APPROVAL: { Icon: BlockedIcon, text: "text-warning", row: "bg-warning/8" },
} as const;

export function GateChecks({ results }: { results: readonly GateRuleResult[] }) {
  return (
    <ul className="divide-y divide-border">
      {results.map((result) => {
        const { Icon, text, row } = VERDICT[result.verdict];
        return (
          <li key={result.rule} className={cn("flex gap-3 px-4 py-2.5", row)}>
            <Icon strokeWidth={2} className={cn("mt-0.5 shrink-0", text)} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono font-medium">{result.rule}</span>
                <span className={cn("font-mono text-xs font-medium", text)}>{result.verdict}</span>
              </div>
              <p className="text-pretty text-muted-foreground">{result.reason}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
