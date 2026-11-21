import { UNCLASSIFIED_DREAM_SOURCE } from "../../memory/provenance";
import type { MemoryRecord } from "../../types";
import { nowIso } from "../../utils/time";
import type { MemoryCandidateRow } from "./candidates";

export interface CandidateApprovalWrite {
  guard: D1PreparedStatement;
  complete(memoryId: string): D1PreparedStatement;
}

function pendingSnapshot(candidate: MemoryCandidateRow) {
  return {
    sql: `c.namespace=? AND c.id=? AND c.source=? AND c.status='pending' AND c.target_memory_id IS NULL
      AND c.updated_at=? AND c.content=? AND c.source_message_ids IS ? AND c.provenance IS ?`,
    args: [candidate.namespace, candidate.id, UNCLASSIFIED_DREAM_SOURCE, candidate.updated_at,
      candidate.content, candidate.source_message_ids, candidate.provenance ?? null]
  };
}

export function settleOperationCandidate(
  db: D1Database,
  candidate: MemoryCandidateRow,
  decision: { status: "pending" | "approved" | "discarded"; note: string; source?: string; memoryId?: string }
): D1PreparedStatement {
  const snapshot = pendingSnapshot(candidate);
  return db.prepare(`UPDATE memory_candidates AS c SET status=?, decision_note=?, source=?, target_memory_id=?, updated_at=?
    WHERE ${snapshot.sql}`).bind(decision.status, decision.note, decision.source ?? UNCLASSIFIED_DREAM_SOURCE,
    decision.memoryId ?? null, nowIso(), ...snapshot.args);
}

/** Check the reviewed snapshots and record the result in the same batch as the memory write. */
export function operationApprovalWrite(
  db: D1Database,
  candidate: MemoryCandidateRow,
  decision: { source: string; note: string; target: MemoryRecord | null }
): CandidateApprovalWrite {
  const snapshot = pendingSnapshot(candidate);
  const { target } = decision;
  const targetCheck = target ? `AND EXISTS (SELECT 1 FROM memories m WHERE m.namespace=? AND m.id=?
    AND m.status='active' AND m.pinned=0 AND m.updated_at=? AND m.content=?
    AND m.source IS ? AND m.authored_by IS ? AND m.provenance IS ? AND m.type=? AND m.fact_key IS ?
    AND m.version_status IS ? AND NOT EXISTS (SELECT 1 FROM memory_revocations
      WHERE namespace=m.namespace AND ref='memory:' || m.id))` : "";
  const guard = db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM memory_candidates c WHERE ${snapshot.sql}
    AND NOT EXISTS (SELECT 1 FROM memory_revocations r WHERE r.namespace=c.namespace AND r.ref IN (
      SELECT 'candidate:' || c.id UNION ALL SELECT value FROM json_each(c.provenance,'$.inputs')))
    AND NOT EXISTS (SELECT 1 FROM json_each(c.source_message_ids) j WHERE NOT EXISTS (
      SELECT 1 FROM messages WHERE namespace=c.namespace AND id=j.value)))
    ${targetCheck} THEN 1 ELSE json('operation review changed') END`)
    .bind(...snapshot.args, ...(target ? [candidate.namespace, target.id, target.updated_at, target.content,
      target.source, target.authored_by ?? null, target.provenance ?? null, target.type, target.fact_key ?? null,
      target.version_status ?? null] : []));
  return {
    guard,
    complete: (memoryId) => settleOperationCandidate(db, candidate, {
      source: decision.source, note: decision.note, status: "approved", memoryId
    })
  };
}
