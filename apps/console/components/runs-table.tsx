"use client";

import Link from "next/link";
import { useState } from "react";
import { RUN_STATUSES, type RunStatus } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { StatusPill } from "./status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

export type RunRow = {
  runId: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  template: string;
  status: RunStatus;
  gatePassed: number;
  gateTotal: number;
  cost: string;
  duration: string;
  startedAt: string;
};

type Filter = RunStatus | "all";

const FILTERS: Filter[] = ["all", ...RUN_STATUSES];

export function RunsTable({ rows }: { rows: RunRow[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const visible = filter === "all" ? rows : rows.filter((row) => row.status === filter);

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Filter runs by status" className="flex w-fit gap-0.5 rounded-lg bg-muted p-0.5">
        {FILTERS.map((option) => {
          const count = option === "all" ? rows.length : rows.filter((row) => row.status === option).length;
          const active = option === filter;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(option)}
              className={cn(
                "relative flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium capitalize transition-[background-color,color,box-shadow] duration-150 ease-out after:absolute after:inset-x-0 after:-inset-y-1.5",
                active ? "bg-surface text-foreground shadow-border" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option}
              <span className="font-mono text-muted-foreground tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="overflow-hidden rounded-xl bg-surface shadow-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Issue</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden sm:table-cell">Gate</TableHead>
              <TableHead className="hidden md:table-cell">Template</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Duration</TableHead>
              <TableHead className="hidden lg:table-cell">Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow key={row.runId} className="relative hover:bg-muted/60">
                <TableCell className="max-w-0 min-w-36 whitespace-normal sm:min-w-64">
                  <Link
                    href={`/runs/${row.runId}`}
                    className="block font-medium text-pretty outline-none after:absolute sm:truncate after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-primary"
                  >
                    {row.issueTitle}
                  </Link>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {row.repo}#{row.issueNumber}
                  </span>
                </TableCell>
                <TableCell>
                  <StatusPill status={row.status} />
                </TableCell>
                <TableCell className="hidden font-mono tabular-nums sm:table-cell">
                  {row.gateTotal === 0 ? (
                    <span className="font-sans text-muted-foreground">Not run</span>
                  ) : (
                    <span className={row.gatePassed === row.gateTotal ? "text-success" : "text-danger"}>
                      {row.gatePassed}/{row.gateTotal}
                    </span>
                  )}
                </TableCell>
                <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{row.template}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{row.cost}</TableCell>
                <TableCell className="hidden text-right font-mono text-muted-foreground tabular-nums sm:table-cell">
                  {row.duration}
                </TableCell>
                <TableCell className="hidden text-muted-foreground tabular-nums lg:table-cell">{row.startedAt}</TableCell>
              </TableRow>
            ))}
            {visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-muted-foreground">
                  No {filter} runs.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
