"use client";

import Link from "next/link";
import { useDeferredValue, useState } from "react";
import { STATUS_LABEL } from "@/lib/labels";
import { RUN_STATUSES, type RunStatus } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { ChevronIcon } from "./icons";
import { StatusPill } from "./status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

export type RunRow = {
  runId: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  status: RunStatus;
  /** Why the run ended this way, in a few words. */
  outcome: string;
  cost: string;
  duration: string;
  startedAt: string;
};

type Filter = RunStatus | "all";

const FILTERS: Filter[] = ["all", ...RUN_STATUSES];
const COLUMNS = 7;

const NO_MATCH: Record<RunStatus, string> = {
  opened: "No run has opened a pull request.",
  awaiting_approval: "No run is waiting for approval.",
  blocked: "No run was blocked by the gate.",
  failed: "No run failed.",
  cancelled: "No run was cancelled.",
};

function filterLabel(filter: Filter): string {
  return filter === "all" ? "All" : STATUS_LABEL[filter];
}

export function RunsTable({ rows }: { rows: RunRow[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [filtered, setFiltered] = useState(false);
  // The pressed button updates at once; the table follows when React has time, and dims until it does.
  const shown = useDeferredValue(filter);
  const pending = shown !== filter;
  const visible = shown === "all" ? rows : rows.filter((row) => row.status === shown);

  function choose(option: Filter) {
    setFilter(option);
    setFiltered(true);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
        <div role="group" aria-label="Filter runs by status" className="flex w-fit gap-0.5 rounded-lg bg-muted p-0.5">
          {FILTERS.map((option) => {
            const count = option === "all" ? rows.length : rows.filter((row) => row.status === option).length;
            const active = option === filter;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                onClick={() => choose(option)}
                className={cn(
                  "relative flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 ease-out after:absolute after:inset-x-0 after:-inset-y-1.5 focus-visible:outline-offset-0",
                  active ? "bg-surface text-foreground shadow-border" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {filterLabel(option)}
                <span className="text-muted-foreground tabular-nums">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <p role="status" className="sr-only">
        {filtered ? `${filterLabel(shown)}: showing ${visible.length} of ${rows.length} runs` : ""}
      </p>

      <div
        aria-busy={pending}
        className={cn(
          "overflow-hidden rounded-xl bg-surface shadow-border transition-[opacity] duration-150 ease-out",
          pending && "opacity-60",
        )}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Issue</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden sm:table-cell">Gate</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Cost</TableHead>
              <TableHead className="hidden text-right md:table-cell">Duration</TableHead>
              <TableHead className="hidden lg:table-cell">Started</TableHead>
              <TableHead className="w-8">
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody key={shown} className={cn(filtered && "fade-in")}>
            {visible.map((row) => (
              <TableRow key={row.runId} className="group relative hover:bg-muted/60">
                <TableCell className="max-w-0 min-w-40 whitespace-normal sm:min-w-64">
                  <Link
                    href={`/runs/${row.runId}`}
                    className="block font-medium text-pretty outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-primary sm:truncate"
                  >
                    {row.issueTitle}
                  </Link>
                  <span className="hidden truncate font-mono text-xs text-muted-foreground sm:block">
                    {row.repo}#{row.issueNumber}
                  </span>
                  <span className="block text-xs text-muted-foreground sm:hidden">{row.outcome}</span>
                </TableCell>
                <TableCell>
                  <StatusPill status={row.status} />
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">{row.outcome}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{row.cost}</TableCell>
                <TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
                  {row.duration}
                </TableCell>
                <TableCell className="hidden text-muted-foreground tabular-nums lg:table-cell">{row.startedAt}</TableCell>
                <TableCell className="w-8 pl-0 text-muted-foreground">
                  <ChevronIcon className="transition-[translate,color] duration-150 ease-out group-hover:text-foreground motion-safe:group-hover:translate-x-0.5" />
                </TableCell>
              </TableRow>
            ))}
            {shown !== "all" && visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMNS} className="py-8 whitespace-normal">
                  <p className="font-medium">{NO_MATCH[shown]}</p>
                  <button
                    type="button"
                    onClick={() => choose("all")}
                    className="mt-1 text-sm font-medium text-primary underline-offset-2 hover:underline"
                  >
                    Show all {rows.length} runs
                  </button>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
