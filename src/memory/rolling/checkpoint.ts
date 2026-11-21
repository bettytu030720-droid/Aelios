import { nowIso } from "../../utils/time";
import type { GroundedWindow } from "./apply";
import type { RollingClaim } from "./inbox";
import type { RollingFailure, RollingWrites } from "./progress";
import type { RollingState } from "./state";

interface StateWrite {
  name: string;
  value: string | null;
  state: RollingState;
}

function guard(claim: RollingClaim, at = claim.at, state?: StateWrite, doneAt: string | null = null) {
  return {
    sql: `? = (SELECT COUNT(*) FROM rolling_inbox WHERE namespace=? AND window_key=? AND claimed_at=? AND done_at IS ?)
      ${state ? "AND (SELECT value FROM processing_cursors WHERE name=?) IS ?" : ""}`,
    args: [claim.rows.length, claim.namespace, claim.key, at, doneAt, ...(state ? [state.name, state.value] : [])]
  };
}

/** Included in the same D1 batch as a memory write so an expired or deleted lease aborts the batch. */
export function assertRollingLease(db: D1Database, claim: RollingClaim): D1PreparedStatement {
  const owned = guard(claim);
  return db.prepare(`SELECT CASE WHEN ${owned.sql} THEN 1 ELSE json('rolling lease lost') END`)
    .bind(...owned.args);
}

function writeState(db: D1Database, state: StateWrite, at: string, owned: ReturnType<typeof guard>): D1PreparedStatement {
  return db.prepare(`INSERT INTO processing_cursors(name,value,updated_at)
    SELECT ?,?,? WHERE ${owned.sql}
    ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(state.name, JSON.stringify(state.state), at, ...owned.args);
}

function checkpoint(db: D1Database, claim: RollingClaim, at: string | null, state?: StateWrite): D1PreparedStatement {
  const owned = guard(claim, claim.at, state);
  return db.prepare(`UPDATE rolling_inbox SET progress=?,claimed_at=?
    WHERE namespace=? AND window_key=? AND claimed_at=? AND done_at IS NULL AND ${owned.sql}`)
    .bind(JSON.stringify(claim.progress), at, claim.namespace, claim.key, claim.at, ...owned.args);
}

function audit(
  db: D1Database, claim: RollingClaim, id: string, type: string, payload: unknown, at: string, state?: StateWrite
): D1PreparedStatement {
  const owned = guard(claim, claim.at, state);
  return db.prepare(`INSERT INTO memory_events(id,namespace,event_type,memory_id,payload_json,created_at)
    SELECT ?,?,?,NULL,?,? WHERE ${owned.sql} ON CONFLICT(id) DO NOTHING`)
    .bind(id, claim.namespace, type, JSON.stringify(payload), at, ...owned.args);
}

export async function saveRollingProgress(db: D1Database, claim: RollingClaim, retry = false): Promise<boolean> {
  const at = retry ? null : nowIso();
  const result = await checkpoint(db, claim, at).run();
  if (result.meta.changes && at) claim.at = at;
  return Boolean(result.meta.changes);
}

export async function releaseInterruptedWindow(db: D1Database, claim: RollingClaim): Promise<boolean> {
  const result = await db.prepare(`UPDATE rolling_inbox SET claimed_at=NULL
    WHERE namespace=? AND window_key=? AND claimed_at=? AND done_at IS NULL`)
    .bind(claim.namespace, claim.key, claim.at).run();
  return Boolean(result.meta.changes);
}

export interface RollingDraft {
  part: number;
  grounded: GroundedWindow;
  recall_ids: string[];
}

export async function saveRollingDraft(db: D1Database, claim: RollingClaim, draft: RollingDraft): Promise<boolean> {
  const at = nowIso();
  const [, saved] = await db.batch([
    audit(db, claim, `evt_${claim.key}_draft_${draft.part}`, "rolling_draft", {
      window_key: claim.key, ...draft
    }, at),
    checkpoint(db, claim, at)
  ]);
  if (saved.meta.changes) claim.at = at;
  return Boolean(saved.meta.changes);
}

function draftIds(claim: RollingClaim): string[] {
  return claim.progress.completed.map(part => `evt_${claim.key}_draft_${part}`);
}

export async function loadRollingDrafts(db: D1Database, claim: RollingClaim): Promise<RollingDraft[]> {
  const ids = draftIds(claim);
  if (!ids.length) return [];
  const rows = await db.prepare(`SELECT payload_json FROM memory_events WHERE namespace=? AND event_type='rolling_draft'
    AND id IN (SELECT value FROM json_each(?))`).bind(claim.namespace, JSON.stringify(ids)).all<{ payload_json: string }>();
  if (rows.results.length !== ids.length) throw new Error("Rolling drafts missing");
  return rows.results.map(row => JSON.parse(row.payload_json) as RollingDraft).sort((a, b) => a.part - b.part);
}

export async function finishRollingWindow(
  db: D1Database,
  claim: RollingClaim,
  { failure, state, writes }: { failure?: RollingFailure; state?: StateWrite; writes?: RollingWrites } = {}
): Promise<boolean> {
  const at = nowIso();
  const { progress } = claim;
  // Only a window that hasn't begun writing can be extracted again by nightly Dream.
  const handoff = Boolean(failure && !progress.committing);
  const owned = guard(claim, claim.at, state);
  const beforeSettlement = [
    audit(db, claim, `evt_${claim.key}`, "rolling_window", {
      window_key: claim.key,
      status: failure ? "failed" : "completed",
      error: failure?.reason ?? null,
      failure,
      last_failure: progress.lastFailure,
      disposition: failure ? (handoff ? "nightly" : "check_writes") : undefined,
      model: progress.model,
      started_at: progress.startedAt,
      message_count: claim.rows.length,
      attempts: claim.attempts,
      triage: progress.triage ?? null,
      clef_calls: progress.clefCalls,
      extractor_calls: progress.extractorCalls,
      event_count: progress.eventCount,
      writes,
      duration_ms: Date.parse(at) - Date.parse(progress.startedAt)
    }, at, state),
    ...(progress.completed.length ? [db.prepare(`DELETE FROM memory_events
      WHERE namespace=? AND event_type='rolling_draft' AND id IN (SELECT value FROM json_each(?)) AND ${owned.sql}`)
      .bind(claim.namespace, JSON.stringify(draftIds(claim)), ...owned.args)] : [])
  ];
  const assignments = handoff ? "rolling_skipped=1,window_key=NULL,claimed_at=NULL" : "done_at=?";
  const results = await db.batch([
    ...beforeSettlement,
    db.prepare(`UPDATE rolling_inbox SET ${assignments},progress=NULL,error=?
      WHERE namespace=? AND window_key=? AND claimed_at=? AND done_at IS NULL AND ${owned.sql}`)
      .bind(...(handoff ? [] : [at]), failure?.reason ?? null, claim.namespace, claim.key, claim.at, ...owned.args),
    ...(state ? [writeState(db, state, at, guard(claim, claim.at, state, at))] : [])
  ]);
  return Boolean(results[beforeSettlement.length].meta.changes);
}
