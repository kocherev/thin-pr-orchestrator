import type { RunRecord } from "@thin-pr/github";
import { z } from "zod";

export type { RunRecord };

export const RUN_STATUSES = ["opened", "blocked", "failed"] as const;

const count = z.number().int().nonnegative();
const usd = z.number().nonnegative();
const runStatus = z.enum(RUN_STATUSES);

const usageSchema = z
  .object({
    model: z.string().min(1),
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    costUsd: usd,
    durationMs: count,
  })
  .strict();

const stepSchema = z
  .object({
    id: z.enum(["plan", "implement", "verify", "review", "write"]),
    attempt: z.number().int().positive(),
    loop: count,
    outcome: z.enum(["finished", "looped", "failed"]),
    startedAt: z.iso.datetime(),
    durationMs: count,
    usage: z.array(usageSchema),
    summary: z.string(),
  })
  .strict();

const gateRuleSchema = z
  .object({
    rule: z.enum(["plan", "contracts", "diff", "budget", "paths", "secrets", "typecheck", "tests", "review"]),
    verdict: z.enum(["PASS", "FAIL"]),
    reason: z.string(),
  })
  .strict();

const diffSchema = z
  .object({
    files: z.array(z.object({ path: z.string().min(1), added: count, removed: count }).strict()),
    meaningful: z.boolean(),
    patch: z.string(),
  })
  .strict();

const checkSchema = z
  .object({
    name: z.enum(["typecheck", "test"]),
    command: z.string().min(1),
    exitCode: z.number().int(),
    durationMs: count,
    logTail: z.string(),
  })
  .strict();

/** Parses the RunRecord v1 export from `packages/github/src/record.ts`. The loader's return type keeps the two in step. */
export const runRecordSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1),
    repo: z.string().min(1),
    issue: z.object({ number: z.number().int().positive(), title: z.string().min(1), url: z.url() }).strict(),
    template: z.string().min(1),
    status: runStatus,
    steps: z.array(stepSchema),
    gate: z.array(gateRuleSchema),
    diff: diffSchema.nullable(),
    checks: z.array(checkSchema),
    pullRequest: z.object({ number: z.number().int().positive(), url: z.url() }).strict().nullable(),
    totals: z.object({ costUsd: usd, durationMs: count, inputTokens: count, outputTokens: count }).strict(),
  })
  .strict();

/** Parses `evals/report.json`, the `ReportFile` that `scripts/eval.ts` writes. */
export const evalReportSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.iso.datetime(),
    cases: z.array(
      z
        .object({
          caseId: z.string().min(1),
          title: z.string().min(1),
          expected: z.enum(["opened", "blocked"]),
          actual: runStatus,
          failedRules: z.array(z.string().min(1)),
          costUsd: usd,
          durationMs: count,
          models: z.array(z.string().min(1)),
        })
        .strict(),
    ),
  })
  .strict();

export type RunStatus = RunRecord["status"];
export type RunStep = RunRecord["steps"][number];
export type GateRuleResult = RunRecord["gate"][number];
export type CheckResult = RunRecord["checks"][number];
export type Diff = NonNullable<RunRecord["diff"]>;
export type EvalReport = z.infer<typeof evalReportSchema>;
export type EvalCase = EvalReport["cases"][number];
