import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type SectionProps = {
  id: string;
  title: string;
  meta?: ReactNode;
  className?: string;
  children: ReactNode;
};

export function Section({ id, title, meta, className, children }: SectionProps) {
  return (
    <section aria-labelledby={id} className={cn("flex min-w-0 flex-col gap-2.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        {meta ? <div className="text-xs text-muted-foreground tabular-nums">{meta}</div> : null}
      </div>
      <div className="overflow-hidden rounded-xl bg-surface shadow-border">{children}</div>
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 px-4 py-6 sm:px-6">
      <p className="text-sm font-medium">{title}</p>
      {children ? <div className="max-w-prose text-sm text-pretty text-muted-foreground">{children}</div> : null}
    </div>
  );
}
