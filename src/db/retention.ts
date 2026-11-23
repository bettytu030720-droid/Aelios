import { WORLD_FACT_TYPE } from "../memory/canonicalTypes";
import { deleteFtsRowsByIds } from "../memory/fts";
import { nowIso } from "../utils/time";

// ---------------------------------------------------------------------------
// Batch size for SQL IN clauses and Vectorize deleteByIds.
// D1 limits each statement to 100 bound variables. Queries here bind an extra
// leading param (namespace) on top of the id placeholders, so a batch of N ids
// binds N+1 variables. Keep the batch size below 99 to stay safely under the
// limit; 90 leaves headroom for any future extra params.
// ---------------------------------------------------------------------------

export const RETENTION_BATCH_SIZE = 90;

// ---------------------------------------------------------------------------
// messages: delete rows older than cutoff
// ---------------------------------------------------------------------------

export async function deleteOldMessages(
  db: D1Database,
  namespace: string,
  cutoff: string
): Promise<number> {
  let deletedTotal = 0;
  for (;;) {
    const batch = await db
      .prepare(
        `SELECT id FROM messages
         WHERE namespace = ? AND created_at < ?
         LIMIT ?`
      )
      .bind(namespace, cutoff, RETENTION_BATCH_SIZE)
      .all<{ id: string }>();
    const ids = (batch.results ?? []).map((row) => row.id);
    if (ids.length === 0) break;

    try {
      await deleteFtsRowsByIds(db, "message_fts", "message_id", ids);
    } catch (error) {
      console.error("retention: message fts cleanup failed", error);
    }

    const placeholders = ids.map(() => "?").join(", ");
    const result = await db
      .prepare(`DELETE FROM messages WHERE namespace = ? AND id IN (${placeholders})`)
      .bind(namespace, ...ids)
      .run();
    const deleted = result.meta.changes ?? 0;
    deletedTotal += deleted;
    if (ids.length < RETENTION_BATCH_SIZE || deleted === 0) break;
  }
  return deletedTotal;
}

// ---------------------------------------------------------------------------
// usage_logs: delete rows older than cutoff
// ---------------------------------------------------------------------------

export async function deleteOldUsageLogs(
  db: D1Database,
  namespace: string,
  cutoff: string
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM usage_logs WHERE namespace = ? AND created_at < ?")
    .bind(namespace, cutoff)
    .run();
  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// memory_events: delete rows older than cutoff
// ---------------------------------------------------------------------------

export async function deleteOldMemoryEvents(
  db: D1Database,
  namespace: string,
  cutoff: string
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM memory_events WHERE namespace = ? AND created_at < ?")
    .bind(namespace, cutoff)
    .run();
  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// idempotency_keys: delete rows older than cutoff (namespace-agnostic)
// ---------------------------------------------------------------------------

export async function deleteOldIdempotencyKeys(
  db: D1Database,
  cutoff: string
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM idempotency_keys WHERE created_at < ?")
    .bind(cutoff)
    .run();
  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// memories: mark expired — active, non-pinned, non-identity/persona memories
//           whose updated_at is older than cutoff become status=expired.
//           Returns the id/vector_id of newly expired records so caller
//           can sync Vectorize deletion.
// ---------------------------------------------------------------------------

export interface ExpiredMemoryRef {
  id: string;
  vector_id: string | null;
}

export async function expireOldMemories(
  db: D1Database,
  namespace: string,
  cutoff: string
): Promise<{ count: number; expired: ExpiredMemoryRef[] }> {
  const now = nowIso();

  // First, select the records that will be expired. A memory counts as in use
  // when it was last rewritten, recalled (last_injected_at) or seen again
  // (last_seen_at), whichever is latest; recall only writes the lifecycle row.
  const toExpire = await db
    .prepare(
      `SELECT m.id, m.vector_id
       FROM memories m
       LEFT JOIN memory_lifecycle lc ON lc.memory_id = m.id
       WHERE m.namespace = ?
         AND m.status = 'active'
         AND m.pinned = 0
         AND m.type NOT IN ('identity', 'persona')
         AND MAX(
           m.updated_at,
           COALESCE(lc.last_injected_at, m.updated_at),
           COALESCE(lc.last_seen_at, m.updated_at)
         ) < ?`
    )
    .bind(namespace, cutoff)
    .all<ExpiredMemoryRef>();

  const expired = toExpire.results ?? [];
  if (expired.length === 0) return { count: 0, expired: [] };

  // Then mark exactly those expired, so the caller's FTS/Vectorize cleanup
  // matches what changed.
  const ids = expired.map((m) => m.id);
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += RETENTION_BATCH_SIZE) {
    const batch = ids.slice(i, i + RETENTION_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    statements.push(
      db
        .prepare(
          `UPDATE memories
           SET status = 'expired', updated_at = ?
           WHERE namespace = ? AND status = 'active' AND id IN (${placeholders})`
        )
        .bind(now, namespace, ...batch)
    );
  }
  await db.batch(statements);

  return { count: expired.length, expired };
}

// ---------------------------------------------------------------------------
// memories: list hard-deletable rows — status in (deleted, superseded, expired)
//           and updated_at older than cutoff
// ---------------------------------------------------------------------------

export interface HardDeletableMemory {
  id: string;
  vector_id: string | null;
}

export async function listHardDeletableMemories(
  db: D1Database,
  namespace: string,
  cutoff: string
): Promise<HardDeletableMemory[]> {
  const result = await db
    .prepare(
      `SELECT id, vector_id
       FROM memories
       WHERE namespace = ?
         AND status IN ('deleted', 'superseded', 'expired')
         AND updated_at < ?`
    )
    .bind(namespace, cutoff)
    .all<HardDeletableMemory>();
  return result.results ?? [];
}

// ---------------------------------------------------------------------------
// memories: list stale active world_fact rows for direct hard delete —
//           non-pinned world_fact memories whose latest activity
//           (updated_at / last_injected_at / last_seen_at) is older than cutoff.
// ---------------------------------------------------------------------------

export async function listStaleWorldFacts(
  db: D1Database,
  namespace: string,
  cutoff: string
): Promise<HardDeletableMemory[]> {
  const result = await db
    .prepare(
      `SELECT m.id, m.vector_id
       FROM memories m
       LEFT JOIN memory_lifecycle lc ON lc.memory_id = m.id
       WHERE m.namespace = ?
         AND m.status = 'active'
         AND m.pinned = 0
         AND m.type = ?
         AND MAX(
           m.updated_at,
           COALESCE(lc.last_injected_at, m.updated_at),
           COALESCE(lc.last_seen_at, m.updated_at)
         ) < ?`
    )
    .bind(namespace, WORLD_FACT_TYPE, cutoff)
    .all<HardDeletableMemory>();
  return result.results ?? [];
}

// ---------------------------------------------------------------------------
// memories: hard delete by ids (single batch).
//           Caller is responsible for batching via hardDeleteMemoriesBatched.
// ---------------------------------------------------------------------------

async function hardDeleteMemoriesBatch(
  db: D1Database,
  namespace: string,
  ids: string[]
): Promise<number> {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  try {
    await deleteFtsRowsByIds(db, "memory_fts", "memory_id", ids);
  } catch (error) {
    console.error("retention: memory fts hard-delete cleanup failed", error);
  }
  // 记忆删了，改写前留的旧版也一起删：忘掉就是忘掉。
  try {
    await db
      .prepare(`DELETE FROM memory_revisions WHERE memory_id IN (${placeholders})`)
      .bind(...ids)
      .run();
  } catch (error) {
    console.error("retention: memory revisions hard-delete cleanup failed", error);
  }
  try {
    await db
      .prepare(`DELETE FROM memory_lifecycle WHERE memory_id IN (${placeholders})`)
      .bind(...ids)
      .run();
  } catch (error) {
    console.error("retention: memory lifecycle hard-delete cleanup failed", error);
  }
  const result = await db
    .prepare(
      `DELETE FROM memories WHERE namespace = ? AND id IN (${placeholders})`
    )
    .bind(namespace, ...ids)
    .run();
  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// memories: hard delete in batches of RETENTION_BATCH_SIZE
// ---------------------------------------------------------------------------

export async function hardDeleteMemoriesBatched(
  db: D1Database,
  namespace: string,
  ids: string[]
): Promise<number> {
  let total = 0;
  for (let i = 0; i < ids.length; i += RETENTION_BATCH_SIZE) {
    const batch = ids.slice(i, i + RETENTION_BATCH_SIZE);
    total += await hardDeleteMemoriesBatch(db, namespace, batch);
  }
  return total;
}

// ---------------------------------------------------------------------------
// processing_cursors: read cursor value (returns null if not set)
// ---------------------------------------------------------------------------

export async function readCursor(
  db: D1Database,
  name: string
): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM processing_cursors WHERE name = ?")
    .bind(name)
    .first<{ value: string }>();
  return row?.value ?? null;
}

// ---------------------------------------------------------------------------
// processing_cursors: upsert cursor value
// ---------------------------------------------------------------------------

export async function writeCursor(
  db: D1Database,
  name: string,
  value: string
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO processing_cursors (name, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(name, value, now)
    .run();
}
