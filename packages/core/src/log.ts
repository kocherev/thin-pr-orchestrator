import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { STEP_IDS, type RunEvent } from "./types.js";

export type NewRunEvent = Omit<RunEvent, "seq">;

export type EventLog = {
  append(event: NewRunEvent): RunEvent;
  read(runId: string): RunEvent[];
  close(): void;
};

const usageSchema = z
  .object({
    model: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    costUsd: z.number(),
    durationMs: z.number(),
  })
  .strict();

const rowSchema = z.object({
  seq: z.number(),
  run_id: z.string(),
  template_id: z.string(),
  step: z.enum(STEP_IDS).nullable(),
  kind: z.enum(["started", "finished", "looped", "failed", "completed"]),
  attempt: z.number(),
  output: z.string().nullable(),
  feedback: z.string().nullable(),
  usage: z.string(),
  error: z.string().nullable(),
});

export function openEventLog(path: string): EventLog {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      step TEXT,
      kind TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      output TEXT,
      feedback TEXT,
      usage TEXT NOT NULL,
      error TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO events (run_id, template_id, step, kind, attempt, output, feedback, usage, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const select = db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY seq");

  return {
    append(event) {
      const { lastInsertRowid } = insert.run(
        event.runId,
        event.templateId,
        event.step,
        event.kind,
        event.attempt,
        event.output === null ? null : JSON.stringify(event.output),
        event.feedback,
        JSON.stringify(event.usage),
        event.error,
      );
      return { seq: Number(lastInsertRowid), ...event };
    },
    read(runId) {
      return select.all(runId).map((value) => {
        const row = rowSchema.parse(value);
        return {
          seq: row.seq,
          runId: row.run_id,
          templateId: row.template_id,
          step: row.step,
          kind: row.kind,
          attempt: row.attempt,
          output: row.output === null ? null : z.json().parse(JSON.parse(row.output)),
          feedback: row.feedback,
          usage: z.array(usageSchema).parse(JSON.parse(row.usage)),
          error: row.error,
        };
      });
    },
    close() {
      db.close();
    },
  };
}
