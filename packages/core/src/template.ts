import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { isNode, LineCounter, parseDocument, type Document } from "yaml";
import { z } from "zod";
import type { WorkflowTemplate } from "./types.js";

const retries = z.number().int().nonnegative();
const gate = z.string().min(1).optional();

const planStep = z
  .object({
    id: z.literal("plan"),
    specialist: z.literal("planner"),
    retries,
    inputs: z.tuple([z.literal("issue"), z.literal("templateId")]),
    outputs: z.tuple([z.literal("summary"), z.literal("steps")]),
    gate,
  })
  .strict();

const implementStep = z
  .object({
    id: z.literal("implement"),
    specialist: z.literal("implementer"),
    retries,
    inputs: z.tuple([z.literal("issue"), z.literal("planSummary")]),
    outputs: z.tuple([z.literal("summary"), z.literal("files")]),
    gate,
  })
  .strict();

const testStep = z
  .object({
    id: z.literal("test"),
    specialist: z.literal("tester"),
    retries,
    inputs: z.tuple([z.literal("issue"), z.literal("changeSummary")]),
    outputs: z.tuple([z.literal("summary"), z.literal("passed")]),
    gate,
  })
  .strict();

const reviewStep = z
  .object({
    id: z.literal("review"),
    specialist: z.literal("reviewer"),
    retries,
    inputs: z.tuple([z.literal("issue"), z.literal("testSummary")]),
    outputs: z.tuple([z.literal("summary"), z.literal("notes")]),
    gate,
  })
  .strict();

const gateStep = z
  .object({
    id: z.literal("gate"),
    specialist: z.literal("pr-writer"),
    retries,
    inputs: z.tuple([z.literal("issue"), z.literal("reviewSummary")]),
    outputs: z.tuple([z.literal("summary"), z.literal("title"), z.literal("body")]),
    gate,
  })
  .strict();

const workflowSchema = z
  .object({
    id: z.string().min(1),
    steps: z
      .array(z.discriminatedUnion("id", [planStep, implementStep, testStep, reviewStep, gateStep]))
      .min(1),
  })
  .strict()
  .superRefine((template, ctx) => {
    const seen = new Set<string>();
    template.steps.forEach((step, index) => {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate template step: ${step.id}`,
          path: ["steps", index, "id"],
        });
      }
      seen.add(step.id);
    });
  });

export class TemplateError extends Error {
  readonly file: string;
  readonly line: number;
  readonly column: number;

  constructor(file: string, line: number, column: number, detail: string) {
    super(`${file}:${line}:${column}: ${detail}`);
    this.name = "TemplateError";
    this.file = file;
    this.line = line;
    this.column = column;
  }
}

export function parseTemplate(value: unknown): WorkflowTemplate {
  const parsed = workflowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`template invalid at ${issueText(parsed.error.issues[0])}`);
  }
  return parsed.data;
}

export function loadTemplate(file: string): WorkflowTemplate {
  const source = readFileSync(file, "utf8");
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter });
  const failure = doc.errors[0];
  if (failure) {
    const start = failure.linePos?.[0];
    throw new TemplateError(basename(file), start?.line ?? 1, start?.col ?? 1, failure.message);
  }

  const parsed = workflowSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const pos = locate(doc, lineCounter, issue?.path ?? []);
    throw new TemplateError(basename(file), pos.line, pos.column, issueText(issue));
  }
  return parsed.data;
}

function issueText(issue: { readonly path: readonly PropertyKey[]; readonly message: string } | undefined): string {
  const path = issue?.path.filter((part) => typeof part !== "symbol").join(".") || "(root)";
  return `${path}: ${issue?.message ?? "invalid"}`;
}

function locate(
  doc: Document,
  lineCounter: LineCounter,
  path: readonly PropertyKey[],
): { line: number; column: number } {
  const keys: (string | number)[] = [];
  for (const part of path) {
    if (typeof part === "string" || typeof part === "number") {
      keys.push(part);
    }
  }
  for (let length = keys.length; length >= 0; length -= 1) {
    const node = doc.getIn(keys.slice(0, length), true);
    if (isNode(node) && node.range) {
      const pos = lineCounter.linePos(node.range[0]);
      return { line: pos.line, column: pos.col };
    }
  }
  return { line: 1, column: 1 };
}
