import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isNode, LineCounter, parseDocument, type Document } from "yaml";
import { z } from "zod";
import { STEP_IDS } from "./types.js";

const stepId = z.enum(STEP_IDS);

const stepSchema = z
  .object({
    id: stepId,
    model: z.string().min(1).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    retries: z.number().int().nonnegative(),
    loop: z.object({ back_to: stepId, max: z.number().int().positive() }).strict().optional(),
  })
  .strict();

const limit = z.number().int().positive();

/** The review size a run may reach before a person has to approve it. Lines count added plus removed. */
const budgetSchema = z.object({ max_files: limit, max_lines: limit }).strict();

const templateSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    budget: budgetSchema,
    /** The most one run may spend on model calls, in USD. */
    spend_usd: z.number().positive(),
    steps: z.array(stepSchema).min(1),
  })
  .strict()
  .superRefine((template, ctx) => {
    const seen: string[] = [];
    template.steps.forEach((step, index) => {
      if (seen.includes(step.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate step: ${step.id}`, path: ["steps", index, "id"] });
      }
      if (step.id === "verify" && (step.model || step.effort)) {
        ctx.addIssue({ code: "custom", message: "verify runs checks and takes no model", path: ["steps", index] });
      }
      if (step.loop && !seen.includes(step.loop.back_to)) {
        ctx.addIssue({
          code: "custom",
          message: `loop must go back to an earlier step, not ${step.loop.back_to}`,
          path: ["steps", index, "loop", "back_to"],
        });
      }
      seen.push(step.id);
    });
  });

export type Budget = z.infer<typeof budgetSchema>;
export type TemplateStep = z.infer<typeof stepSchema>;
export type Template = z.infer<typeof templateSchema>;

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

/** Loads every `*.yaml` template in `directory` and returns the one whose `label` matches. */
export function templateForLabel(directory: string, label: string): Template | null {
  const templates = readdirSync(directory)
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .map((name) => loadTemplate(join(directory, name)));
  const matches = templates.filter((template) => template.label === label);
  if (matches.length > 1) {
    throw new Error(`label ${label} names more than one template: ${matches.map((template) => template.id).join(", ")}`);
  }
  return matches[0] ?? null;
}

function loadTemplate(file: string): Template {
  const source = readFileSync(file, "utf8");
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter });
  const failure = doc.errors[0];
  if (failure) {
    const start = failure.linePos?.[0];
    throw new TemplateError(basename(file), start?.line ?? 1, start?.col ?? 1, failure.message);
  }

  const parsed = templateSchema.safeParse(doc.toJS());
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
