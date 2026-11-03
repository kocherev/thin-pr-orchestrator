import type { ReactNode } from "react";

export type Stat = { label: string; value: ReactNode; detail?: ReactNode };

export function StatStrip({ stats, label }: { stats: [Stat, Stat, Stat, Stat]; label: string }) {
  return (
    <dl
      aria-label={label}
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border shadow-border sm:grid-cols-4"
    >
      {stats.map((stat) => (
        <div key={stat.label} className="flex flex-col gap-1 bg-surface px-4 py-3">
          <dt className="text-xs text-muted-foreground">{stat.label}</dt>
          <dd className="font-mono text-lg font-medium tracking-tight tabular-nums">{stat.value}</dd>
          {stat.detail ? <dd className="text-xs text-muted-foreground tabular-nums">{stat.detail}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
