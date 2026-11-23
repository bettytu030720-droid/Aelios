import {
  deleteOldMessages,
  deleteOldUsageLogs,
  deleteOldMemoryEvents,
  deleteOldIdempotencyKeys,
  expireOldMemories,
  listHardDeletableMemories,
  listStaleWorldFacts,
  hardDeleteMemoriesBatched,
  readCursor,
  writeCursor,
  type HardDeletableMemory,
  RETENTION_BATCH_SIZE,
} from "../db/retention";
import { deleteFtsRow } from "./fts";
import type { Env } from "../types";
import { readPositiveInt } from "../utils/request";

// ---------------------------------------------------------------------------
// Retention windows — messages via MESSAGES_RETENTION_DAYS; rest hardcoded
// ---------------------------------------------------------------------------

function messagesRetentionDays(env: Env): number {
  return readPositiveInt(env.MESSAGES_RETENTION_DAYS, 7, 365);
}
const USAGE_LOGS_RETENTION_DAYS = 30;
const MEMORY_EVENTS_RETENTION_DAYS = 30;
const IDEMPOTENCY_KEYS_RETENTION_DAYS = 7;
export const WORLD_FACT_RETENTION_DAYS = 60;
const MEMORY_ACTIVE_EXPIRY_DAYS = 180;
const MEMORY_HARD_DELETE_DAYS = 30;
const THROTTLE_HOURS = 24;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function hoursAgoMs(hours: number): number {
  return Date.now() - hours * 3_600_000;
}

/**
 * Delete Vectorize vectors in batches of RETENTION_BATCH_SIZE.
 * Returns total number of IDs passed in. Errors are logged, not thrown,
 * so caller can decide how to degrade.
 */
async function deleteVectorizeBatched(
  vectorize: Vectorize | VectorizeIndex,
  vectorIds: string[]
): Promise<void> {
  for (let i = 0; i < vectorIds.length; i += RETENTION_BATCH_SIZE) {
    const batch = vectorIds.slice(i, i + RETENTION_BATCH_SIZE);
    await vectorize.deleteByIds(batch);
  }
}

async function hardDeleteWithVectorSync(
  env: Env,
  namespace: string,
  candidates: HardDeletableMemory[],
  label: string
): Promise<{ deleted: number; skipped: number }> {
  if (candidates.length === 0) return { deleted: 0, skipped: 0 };

  const vectorIds = candidates
    .map((m) => m.vector_id)
    .filter((v): v is string => v !== null);

  if (env.VECTORIZE && vectorIds.length > 0) {
    try {
      await deleteVectorizeBatched(env.VECTORIZE, vectorIds);
    } catch (error) {
      console.error(`retention: vectorize delete failed for ${label}, skipping vector-backed memories`, error);
      const noVectorIds = candidates
        .filter((m) => m.vector_id === null)
        .map((m) => m.id);
      const deleted = await hardDeleteMemoriesBatched(env.DB, namespace, noVectorIds);
      return { deleted, skipped: candidates.length - noVectorIds.length };
    }
  }

  if (!env.VECTORIZE) {
    const safeIds = candidates
      .filter((m) => m.vector_id === null)
      .map((m) => m.id);
    const deleted = await hardDeleteMemoriesBatched(env.DB, namespace, safeIds);
    return { deleted, skipped: candidates.length - safeIds.length };
  }

  const allIds = candidates.map((m) => m.id);
  const deleted = await hardDeleteMemoriesBatched(env.DB, namespace, allIds);
  return { deleted, skipped: 0 };
}

// ---------------------------------------------------------------------------
// runMemoryRetention
//
// Called from background tasks after chat. Uses processing_cursors for 24h
// per-namespace throttling so it doesn't run on every request.
// ---------------------------------------------------------------------------

export async function runMemoryRetention(
  env: Env,
  namespace: string
): Promise<{ ran: boolean; stats?: Record<string, number> }> {
  // --- Throttle: only run once per 24h per namespace ---
  const cursorName = `retention:${namespace}`;
  const lastRun = await readCursor(env.DB, cursorName);

  if (lastRun) {
    const lastRunMs = new Date(lastRun).getTime();
    if (lastRunMs > hoursAgoMs(THROTTLE_HOURS)) {
      return { ran: false };
    }
  }

  const now = new Date().toISOString();
  const stats: Record<string, number> = {};

  // 1. Delete old messages
  stats.messages = await deleteOldMessages(env.DB, namespace, daysAgo(messagesRetentionDays(env)));
  const exchanges = await env.DB.prepare("DELETE FROM gateway_exchanges WHERE namespace = ? AND created_at < ?")
    .bind(namespace, daysAgo(messagesRetentionDays(env))).run();
  stats.gatewayExchanges = exchanges.meta.changes ?? 0;

  // 2. Delete old usage_logs
  stats.usageLogs = await deleteOldUsageLogs(env.DB, namespace, daysAgo(USAGE_LOGS_RETENTION_DAYS));

  // 3. Delete old memory_events
  stats.memoryEvents = await deleteOldMemoryEvents(env.DB, namespace, daysAgo(MEMORY_EVENTS_RETENTION_DAYS));

  // 4. Delete old idempotency_keys (namespace-agnostic)
  stats.idempotencyKeys = await deleteOldIdempotencyKeys(env.DB, daysAgo(IDEMPOTENCY_KEYS_RETENTION_DAYS));

  // 5. Hard delete stale world_fact memories (> 60 days without recall or update)
  const staleWorldFacts = await listStaleWorldFacts(env.DB, namespace, daysAgo(WORLD_FACT_RETENTION_DAYS));
  const worldFactDelete = await hardDeleteWithVectorSync(env, namespace, staleWorldFacts, "stale world_fact");
  stats.hardDeletedWorldFacts = worldFactDelete.deleted;
  if (worldFactDelete.skipped > 0) {
    stats.hardDeleteWorldFactsSkipped = worldFactDelete.skipped;
  }

  // 6. Expire old active memories and sync Vectorize
  const expireResult = await expireOldMemories(env.DB, namespace, daysAgo(MEMORY_ACTIVE_EXPIRY_DAYS));
  stats.expiredMemories = expireResult.count;
  if (expireResult.expired.length > 0) {
    for (const memory of expireResult.expired) {
      await deleteFtsRow(env.DB, "memory_fts", "memory_id", memory.id);
    }
  }

  // 6a. Sync Vectorize: remove vectors for newly expired memories
  if (env.VECTORIZE && expireResult.expired.length > 0) {
    const expiredVectorIds = expireResult.expired
      .map((m) => m.vector_id)
      .filter((v): v is string => v !== null);

    if (expiredVectorIds.length > 0) {
      try {
        await deleteVectorizeBatched(env.VECTORIZE, expiredVectorIds);
      } catch (error) {
        // Non-fatal: search layer already filters by status=active in D1,
        // so expired memories won't be injected even if Vectorize vectors linger.
        console.error("retention: failed to delete expired vectors from Vectorize", error);
      }
    }
  }

  // 7. Hard delete terminal memories (deleted/superseded/expired > 30 days)
  const hardCutoff = daysAgo(MEMORY_HARD_DELETE_DAYS);
  const deletable = await listHardDeletableMemories(env.DB, namespace, hardCutoff);
  const terminalDelete = await hardDeleteWithVectorSync(env, namespace, deletable, "terminal memories");
  stats.hardDeletedMemories = terminalDelete.deleted;
  if (terminalDelete.skipped > 0) {
    stats.hardDeleteSkipped = terminalDelete.skipped;
  }

  // 8. Write throttle cursor
  await writeCursor(env.DB, cursorName, now);

  return { ran: true, stats };
}
