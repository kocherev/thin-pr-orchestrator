import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { isPhase, isStepName, type LogEvent, type SpecialistOutput } from "./types.js";

export type NewLogEvent = Omit<LogEvent, "seq">;

export type EventLog = {
  append(event: NewLogEvent): void;
  read(runId: string): readonly LogEvent[];
  close(): void;
};

export function openEventLog(path: string): EventLog {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      issue TEXT NOT NULL,
      from_phase TEXT NOT NULL,
      to_phase TEXT NOT NULL,
      output_json TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO events (run_id, template_id, issue, from_phase, to_phase, output_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const select = db.prepare(`
    SELECT seq, run_id, template_id, issue, from_phase, to_phase, output_json
    FROM events
    WHERE run_id = ?
    ORDER BY seq
  `);

  return {
    append(event) {
      insert.run(
        event.runId,
        event.templateId,
        event.issue,
        event.from,
        event.to,
        event.output === null ? null : JSON.stringify(event.output),
      );
    },
    read(runId) {
      return select.all(runId).map(parseRow);
    },
    close() {
      db.close();
    },
  };
}

function parseRow(row: Record<string, SQLOutputValue>): LogEvent {
  const from = asString(row.from_phase, "from_phase");
  const to = asString(row.to_phase, "to_phase");
  if (!isPhase(from) || !isPhase(to)) {
    throw new Error(`stored phase is not valid: ${from} -> ${to}`);
  }
  return {
    seq: asNumber(row.seq),
    runId: asString(row.run_id, "run_id"),
    templateId: asString(row.template_id, "template_id"),
    issue: asString(row.issue, "issue"),
    from,
    to,
    output: parseOutput(row.output_json),
  };
}

function parseOutput(value: SQLOutputValue | undefined): SpecialistOutput | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = asString(value, "output_json");
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || typeof raw.step !== "string" || typeof raw.summary !== "string") {
    throw new Error("stored specialist output is not valid");
  }
  if (!isStepName(raw.step)) {
    throw new Error(`stored specialist output has unknown step: ${raw.step}`);
  }
  return { step: raw.step, summary: raw.summary };
}

function asString(value: SQLOutputValue | undefined, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`stored ${field} must be text`);
  }
  return value;
}

function asNumber(value: SQLOutputValue | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new Error("stored seq must be a number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
