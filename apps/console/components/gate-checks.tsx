import type { GateRuleResult } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { FailIcon, PassIcon } from "./icons";

export function GateChecks({ results }: { results: readonly GateRuleResult[] }) {
  return (
    <ul className="divide-y divide-border">
      {results.map((result) => {
        const pass = result.verdict === "PASS";
        const Icon = pass ? PassIcon : FailIcon;
        return (
          <li key={result.rule} className={cn("flex gap-3 px-4 py-2.5", !pass && "bg-danger/6")}>
            <Icon strokeWidth={2} className={cn("mt-0.5 shrink-0", pass ? "text-success" : "text-danger")} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono font-medium">{result.rule}</span>
                <span className={cn("font-mono text-xs font-medium", pass ? "text-success" : "text-danger")}>
                  {result.verdict}
                </span>
              </div>
              <p className="text-pretty text-muted-foreground">{result.reason}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
