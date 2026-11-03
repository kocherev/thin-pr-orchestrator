import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Stat = { label: string; value: ReactNode; detail?: ReactNode; tone?: string };

export function StatStrip({ stats, label }: { stats: [Stat, Stat, Stat, Stat]; label: string }) {
  return (
    <dl
      aria-label={label}
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border shadow-border sm:grid-cols-4"
    >
      {stats.map((stat) => (
        <div key={stat.label} className="flex flex-col gap-0.5 bg-surface px-4 py-3">
          <dt className="text-xs text-muted-foreground">{stat.label}</dt>
          <dd className={cn("text-xl font-semibold tracking-tight tabular-nums", stat.tone)}>{stat.value}</dd>
          {stat.detail ? <dd className="text-xs text-pretty text-muted-foreground tabular-nums">{stat.detail}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
