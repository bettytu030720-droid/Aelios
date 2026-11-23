import type { createMemory } from "../../db/memories";
import { deleteMemoryEmbedding, upsertMemoryEmbedding } from "../../memory/embedding";
import type { MemoryCandidateRow } from "../../db/v2";
import { parseJudgeNote } from "../../memory/candidateJudge";
import { parseOrigin, UNCLASSIFIED_DREAM_SOURCE } from "../../memory/provenance";
import type { Env } from "../../types";

export async function syncMemoryEmbeddingBestEffort(env: Env, memory: Awaited<ReturnType<typeof createMemory>>): Promise<void> {
  try {
    await upsertMemoryEmbedding(env, memory);
  } catch (error) {
    console.error("memory api vector upsert failed", { id: memory.id, error });
  }
}

export async function deleteMemoryEmbeddingBestEffort(env: Env, memory: Awaited<ReturnType<typeof createMemory>>): Promise<void> {
  try {
    await deleteMemoryEmbedding(env, memory);
  } catch (error) {
    console.error("memory api vector delete failed", { id: memory.id, error });
  }
}


export function readRecallK(body: Record<string, unknown>, env: Env): number {
  const raw = body.k !== undefined ? body.k : body.top_k;
  const fallback = Number(env.MEMORY_TOP_K || 50);
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return Number.isFinite(fallback) ? Math.floor(fallback) : 50;
}


export function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function toCandidateApiRecord(row: MemoryCandidateRow) {
  return {
    id: row.id,
    namespace: row.namespace,
    type: row.type,
    content: row.content,
    fact_key: row.fact_key,
    confidence: row.confidence,
    importance: row.importance,
    tags: parseJsonArray(row.tags),
    source_message_ids: parseJsonArray(row.source_message_ids),
    ...(row.provenance ? {provenance: JSON.parse(row.provenance)} : {}),
    source: row.source,
    status: row.status,
    target_memory_id: row.target_memory_id,
    decision_note: row.decision_note,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function toJudgeDecisionRecord(row: MemoryCandidateRow) {
  const note = parseJudgeNote(row.decision_note);
  return {
    ...toCandidateApiRecord(row),
    judged_by: note?.judgedBy ?? null,
    reason: note?.reason ?? row.decision_note,
    undone: note?.undone ?? false,
    undoable: row.source !== UNCLASSIFIED_DREAM_SOURCE &&
      (row.status !== "discarded" || !parseOrigin(row.provenance)?.daily_decision) && (note?.undoable ?? false)
  };
}

const UTC_ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

async function countMessagesInRangeExact(
  db: D1Database,
  input: { namespace: string; startCreatedAt: string; endCreatedAt: string }
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM messages
       WHERE namespace = ?
         AND role IN ('user', 'assistant')
         AND created_at >= ?
         AND created_at < ?`
    )
    .bind(input.namespace, input.startCreatedAt, input.endCreatedAt)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function countMessagesInRange(
  db: D1Database,
  input: { namespace: string; startCreatedAt: string; endCreatedAt: string }
): Promise<number> {
  if (input.startCreatedAt >= input.endCreatedAt) return 0;
  if (!UTC_ISO_TIMESTAMP_RE.test(input.startCreatedAt) || !UTC_ISO_TIMESTAMP_RE.test(input.endCreatedAt)) {
    return countMessagesInRangeExact(db, input);
  }

  const startBucket = input.startCreatedAt.slice(0, 13);
  const startBucketFloor = `${startBucket}:00:00.000Z`;
  const endBucket = input.endCreatedAt.slice(0, 13);
  const endBucketFloor = `${endBucket}:00:00.000Z`;
  const endBucketMs = Date.parse(endBucketFloor);
  if (!Number.isFinite(endBucketMs)) {
    return countMessagesInRangeExact(db, input);
  }

  const endOnHourBoundary = input.endCreatedAt === endBucketFloor;
  const lastBucket = endOnHourBoundary
    ? new Date(endBucketMs - 3_600_000).toISOString().slice(0, 13)
    : endBucket;

  const bucketRow = await db
    .prepare(
      `SELECT COALESCE(SUM(row_count), 0) AS count
       FROM message_hour_counts
       WHERE namespace = ? AND hour_bucket >= ? AND hour_bucket <= ?`
    )
    .bind(input.namespace, startBucket, lastBucket)
    .first<{ count: number }>();
  const totalBuckets = bucketRow?.count ?? 0;
  if (totalBuckets === 0) return 0;

  const startIsExact = input.startCreatedAt === startBucketFloor;
  const endBucketNext = new Date(endBucketMs + 3_600_000).toISOString();

  const [leftExcluded, rightExcluded] = await Promise.all([
    startIsExact
      ? Promise.resolve(0)
      : countMessagesInRangeExact(db, { namespace: input.namespace, startCreatedAt: startBucketFloor, endCreatedAt: input.startCreatedAt }),
    endOnHourBoundary
      ? Promise.resolve(0)
      : countMessagesInRangeExact(db, { namespace: input.namespace, startCreatedAt: input.endCreatedAt, endCreatedAt: endBucketNext })
  ]);

  return Math.max(0, totalBuckets - leftExcluded - rightExcluded);
}


export function readDiaryTimeZone(env: Env): string {
  return env.DREAM_TIME_ZONE?.trim() || env.DAILY_DIGEST_TIME_ZONE?.trim() || "Asia/Singapore";
}

