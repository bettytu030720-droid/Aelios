import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";

export type DreamRunStatus = "queued" | "running" | "ok" | "skipped" | "error";
export const DREAM_RUN_STALE_MS = 20 * 60 * 1000;

/** A read-time hint, never a failure verdict or a request to replay memory writes. */
export function describeDreamRun(run: DreamRunRow, now = Date.now()) {
  const active = run.status === "queued" || run.status === "running";
  const age = now - Date.parse(run.started_at);
  const stale = active && (!Number.isFinite(age) || age >= DREAM_RUN_STALE_MS);
  return {
    ...run,
    stale,
    warning: stale ? "Task may have been interrupted; completion is unconfirmed. Do not automatically replay." : null
  };
}
export type DreamRunTrigger = "cron" | "manual";

export interface DreamRunRow {
  id: string;
  namespace: string;
  date_label: string;
  started_at: string;
  finished_at: string | null;
  status: DreamRunStatus;
  reason: string | null;
  model: string | null;
  processed_messages: number | null;
  error: string | null;
  trigger: DreamRunTrigger;
}

export async function insertDreamRun(
  db: D1Database,
  input: {
    namespace: string;
    dateLabel: string;
    trigger: DreamRunTrigger;
  }
): Promise<string> {
  const id = newId("drm");
  const startedAt = nowIso();
  await db
    .prepare(
      `INSERT INTO dream_runs (
         id, namespace, date_label, started_at, status, trigger
       ) VALUES (?, ?, ?, ?, 'running', ?)`
    )
    .bind(id, input.namespace, input.dateLabel, startedAt, input.trigger)
    .run();
  return id;
}

export async function finishDreamRun(
  db: D1Database,
  input: {
    id: string;
    status: Exclude<DreamRunStatus, "queued" | "running">;
    reason?: string | null;
    model?: string | null;
    processedMessages?: number | null;
    error?: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE dream_runs
       SET finished_at = ?,
           status = ?,
           reason = ?,
           model = ?,
           processed_messages = ?,
           error = ?
       WHERE id = ?`
    )
    .bind(
      nowIso(),
      input.status,
      input.reason ?? null,
      input.model ?? null,
      input.processedMessages ?? null,
      input.error ?? null,
      input.id
    )
    .run();
}

/** Atomic admission for manual background jobs, including stale active rows. Force never bypasses it. */
export async function insertQueuedDreamRun(
  db: D1Database,
  input: { namespace: string; dateLabel: string }
): Promise<string | null> {
  const id = newId("drm");
  const result = await db
    .prepare(
      `INSERT INTO dream_runs (id, namespace, date_label, started_at, status, trigger)
       SELECT ?, ?, ?, ?, 'queued', 'manual'
       WHERE NOT EXISTS (
         SELECT 1 FROM dream_runs WHERE namespace = ? AND status IN ('queued', 'running')
       )`
    )
    .bind(id, input.namespace, input.dateLabel, nowIso(), input.namespace)
    .run();
  return result.meta.changes === 1 ? id : null;
}

export async function findActiveDreamRun(db: D1Database, namespace: string): Promise<DreamRunRow | null> {
  return db
    .prepare(
      `SELECT id, namespace, date_label, started_at, finished_at, status, reason, model,
              processed_messages, error, trigger
       FROM dream_runs WHERE namespace = ? AND status IN ('queued', 'running')
       ORDER BY started_at DESC LIMIT 1`
    )
    .bind(namespace)
    .first<DreamRunRow>();
}

/** Only the winner may execute. A redelivered running/error/finished job is never replayed. */
export async function claimQueuedDreamRun(
  db: D1Database,
  input: { runId: string; namespace: string; dateLabel: string }
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE dream_runs SET status = 'running', started_at = ?
       WHERE id = ? AND namespace = ? AND date_label = ? AND trigger = 'manual' AND status = 'queued'`
    )
    .bind(nowIso(), input.runId, input.namespace, input.dateLabel)
    .run();
  return result.meta.changes === 1;
}

/** Conditional cleanup: a producer's ambiguous send failure must not overwrite a claimed run. */
export async function failActiveDreamRun(
  db: D1Database,
  input: { id: string; expectedStatus: "queued" | "running"; reason: string; error: string }
): Promise<void> {
  await db
    .prepare(
      `UPDATE dream_runs SET status = 'error', finished_at = ?, reason = ?, error = ?
       WHERE id = ? AND status = ?`
    )
    .bind(nowIso(), input.reason, input.error, input.id, input.expectedStatus)
    .run();
}

export async function getDreamRun(db: D1Database, input: { id: string; namespace: string }): Promise<DreamRunRow | null> {
  return db
    .prepare(
      `SELECT id, namespace, date_label, started_at, finished_at, status, reason, model,
              processed_messages, error, trigger
       FROM dream_runs WHERE id = ? AND namespace = ?`
    )
    .bind(input.id, input.namespace)
    .first<DreamRunRow>();
}

/**
 * Operator close-out of an unconfirmed task, so a row that will never finish cannot block admission forever.
 * Only an active row already past the stale threshold qualifies: a task that may still be executing is never marked,
 * and a claimed-late queue message finds the row no longer 'queued' and is dropped rather than replayed.
 */
export async function resolveStaleDreamRun(
  db: D1Database,
  input: { id: string; namespace: string; now?: number }
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const result = await db
    .prepare(
      `UPDATE dream_runs SET status = 'error', finished_at = ?, reason = 'marked_interrupted', error = ?
       WHERE id = ? AND namespace = ? AND status IN ('queued', 'running') AND started_at <= ?`
    )
    .bind(
      new Date(now).toISOString(),
      "Marked interrupted by the operator; earlier writes may already exist. Inspect Worker logs before retrying.",
      input.id,
      input.namespace,
      new Date(now - DREAM_RUN_STALE_MS).toISOString()
    )
    .run();
  return result.meta.changes === 1;
}

export async function listDreamRunsForNamespace(
  db: D1Database,
  input: { namespace: string; sinceIso: string; limit?: number }
): Promise<DreamRunRow[]> {
  const limit = input.limit ?? 200;
  const result = await db
    .prepare(
      `SELECT id, namespace, date_label, started_at, finished_at, status, reason, model,
              processed_messages, error, trigger
       FROM dream_runs
       WHERE namespace = ? AND started_at >= ?
       ORDER BY started_at DESC
       LIMIT ?`
    )
    .bind(input.namespace, input.sinceIso, limit)
    .all<DreamRunRow>();
  return result.results ?? [];
}
