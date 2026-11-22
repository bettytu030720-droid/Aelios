import { cleanMessageText } from "../utils/sanitize";
import { deleteFtsRow, toFtsBody, writeFtsRowWithOutcome } from "./fts";
import {
  deleteMappedFtsEntries,
  FTS_BATCH_SIZE,
  FTS_SPECS,
  type FtsKind,
  GLOBAL_CURSOR_SCOPE,
  GLOBAL_MAP_SCOPE,
  getMappedFtsEntries,
  isFtsMapSynced,
  isMissingFtsStateError,
  readMaintenanceState,
  recordMappedFtsEntry,
  writeMaintenanceState
} from "./ftsState";

export type FtsReconcileMode = "sync_map" | "backfill_missing" | "purge_orphans";

export interface FtsBackfillResult {
  messagesIndexed: number;
  memoriesIndexed: number;
  messageOrphansPurged: number;
  memoryOrphansPurged: number;
  failed: number;
}

export interface FtsReconcileResult {
  mode: FtsReconcileMode;
  kind: FtsKind;
  namespace: string | null;
  limit: number;
  dry_run: boolean;
  scanned: number;
  mapped: number;
  indexed: number;
  orphans_purged: number;
  duplicates_purged: number;
  failed: number;
  next_cursor: string | null;
  done: boolean;
}

interface FtsRowPageItem {
  fts_rowid: number;
  namespace: string | null;
  entity_id: string | null;
}

interface SyncFtsMapPageResult {
  scanned: number;
  mapped: number;
  orphansPurged: number;
  duplicatesPurged: number;
  lastRowId: number;
  done: boolean;
}

interface MessageCursorRow {
  id: string;
  namespace: string;
  content: string;
  created_at: string;
  seq: number;
}

interface MemoryCursorRow {
  id: string;
  namespace: string;
  content: string;
  summary: string | null;
  status: string;
  updated_at: string;
}

interface KeysetCursor {
  ts: string;
  seq: number;
  id: string;
}

async function fetchActiveEntitiesForKind(
  db: D1Database,
  kind: FtsKind,
  entityIds: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(entityIds.filter(Boolean))];
  const active = new Map<string, string>();
  if (unique.length === 0) return active;
  for (let index = 0; index < unique.length; index += FTS_BATCH_SIZE) {
    const batch = unique.slice(index, index + FTS_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    const sql = kind === "message"
      ? `SELECT id, namespace FROM messages WHERE id IN (${placeholders}) AND role IN ('user', 'assistant')`
      : `SELECT id, namespace FROM memories WHERE id IN (${placeholders}) AND status = 'active'`;
    const result = await db.prepare(sql).bind(...batch).all<{ id: string; namespace: string }>();
    for (const row of result.results ?? []) {
      active.set(row.id, row.namespace);
    }
  }
  return active;
}

// Walks an FTS5 virtual table strictly by `rowid > afterRowId ORDER BY rowid ASC LIMIT ?`
// (INDEX 64:>), populating fts_entry_map for legacy rows while pruning orphans and duplicates.
async function syncFtsMapPage(
  db: D1Database,
  kind: FtsKind,
  input: {
    afterRowId: number;
    limit: number;
    namespace?: string;
    syncMap: boolean;
    purgeOrphans: boolean;
    dryRun: boolean;
  }
): Promise<SyncFtsMapPageResult> {
  const spec = FTS_SPECS[kind];
  const page = await db
    .prepare(
      `SELECT rowid AS fts_rowid, namespace, ${spec.idColumn} AS entity_id
       FROM ${spec.table}
       WHERE rowid > ?
       ORDER BY rowid ASC
       LIMIT ?`
    )
    .bind(input.afterRowId, input.limit)
    .all<FtsRowPageItem>();

  const rows = page.results ?? [];
  if (rows.length === 0) {
    return { scanned: 0, mapped: 0, orphansPurged: 0, duplicatesPurged: 0, lastRowId: input.afterRowId, done: true };
  }

  const lastRowId = Number(rows[rows.length - 1].fts_rowid);
  const targetRows = input.namespace ? rows.filter((row) => row.namespace === input.namespace) : rows;
  const candidateIds = targetRows.map((row) => row.entity_id ?? "").filter(Boolean);

  const [activeEntities, mappedResult] = await Promise.all([
    fetchActiveEntitiesForKind(db, kind, candidateIds),
    getMappedFtsEntries(db, kind, candidateIds)
  ]);

  const mappedById = new Map<string, number>();
  for (const [id, entry] of mappedResult.entries.entries()) {
    mappedById.set(id, Number(entry.fts_rowid));
  }

  let mapped = 0;
  let orphansPurged = 0;
  let duplicatesPurged = 0;
  const orphanRowIds: number[] = [];
  const staleMapIds: string[] = [];
  const duplicateRowIds: number[] = [];
  const toUpsertMap = new Map<string, { namespace: string; ftsRowId: number }>();

  for (const row of targetRows) {
    const ftsRowId = Number(row.fts_rowid);
    const entityId = row.entity_id ?? "";
    const activeNamespace = entityId ? activeEntities.get(entityId) : undefined;

    if (!entityId || !activeNamespace) {
      if (input.purgeOrphans) {
        orphansPurged += 1;
        orphanRowIds.push(ftsRowId);
        if (entityId && mappedById.get(entityId) === ftsRowId) {
          staleMapIds.push(entityId);
          mappedById.delete(entityId);
        }
      }
      continue;
    }

    const existingRowId = mappedById.get(entityId);
    if (existingRowId !== undefined && existingRowId !== ftsRowId) {
      const keepRowId = Math.max(existingRowId, ftsRowId);
      const dropRowId = Math.min(existingRowId, ftsRowId);
      duplicatesPurged += 1;
      duplicateRowIds.push(dropRowId);
      mappedById.set(entityId, keepRowId);
      if (input.syncMap || keepRowId !== existingRowId) {
        toUpsertMap.set(entityId, { namespace: activeNamespace, ftsRowId: keepRowId });
      }
      continue;
    }

    if (existingRowId === undefined && input.syncMap) {
      mapped += 1;
      mappedById.set(entityId, ftsRowId);
      toUpsertMap.set(entityId, { namespace: activeNamespace, ftsRowId });
    }
  }

  if (!input.dryRun) {
    const rowIdsToDelete = [...new Set([...orphanRowIds, ...duplicateRowIds])];
    for (let index = 0; index < rowIdsToDelete.length; index += FTS_BATCH_SIZE) {
      const batch = rowIdsToDelete.slice(index, index + FTS_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(", ");
      await db.prepare(`DELETE FROM ${spec.table} WHERE rowid IN (${placeholders})`).bind(...batch).run();
    }
    if (staleMapIds.length > 0 && mappedResult.available) {
      await deleteMappedFtsEntries(db, kind, staleMapIds);
    }
    if (mappedResult.available) {
      for (const [entityId, info] of toUpsertMap.entries()) {
        await recordMappedFtsEntry(db, { kind, entityId, namespace: info.namespace, ftsRowId: info.ftsRowId });
      }
    }
  }

  return {
    scanned: rows.length,
    mapped,
    orphansPurged,
    duplicatesPurged,
    lastRowId,
    done: rows.length < input.limit
  };
}

async function fetchMessagesAfterCursor(
  db: D1Database,
  input: { namespace?: string; cursor: KeysetCursor; limit: number }
): Promise<MessageCursorRow[]> {
  const hasCursor = Boolean(input.cursor.ts || input.cursor.id);
  const where: string[] = ["role IN ('user', 'assistant')"];
  const binds: unknown[] = [];
  if (input.namespace) {
    where.unshift("namespace = ?");
    binds.push(input.namespace);
  }
  if (hasCursor) {
    where.push("(created_at, seq, id) > (?, ?, ?)");
    binds.push(input.cursor.ts, input.cursor.seq, input.cursor.id);
  }
  binds.push(input.limit);
  const result = await db
    .prepare(
      `SELECT id, namespace, content, created_at, seq
       FROM messages
       WHERE ${where.join(" AND ")}
       ORDER BY created_at ASC, seq ASC, id ASC
       LIMIT ?`
    )
    .bind(...binds)
    .all<MessageCursorRow>();
  return result.results ?? [];
}

async function fetchMemoriesAfterCursor(
  db: D1Database,
  input: { namespace?: string; cursor: KeysetCursor; limit: number }
): Promise<MemoryCursorRow[]> {
  const hasCursor = Boolean(input.cursor.ts || input.cursor.id);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (input.namespace) {
    where.push("namespace = ?");
    binds.push(input.namespace);
  }
  if (hasCursor) {
    where.push("(updated_at, id) > (?, ?)");
    binds.push(input.cursor.ts, input.cursor.id);
  }
  binds.push(input.limit);
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const result = await db
    .prepare(
      `SELECT id, namespace, content, summary, status, updated_at
       FROM memories
       ${whereSql}
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`
    )
    .bind(...binds)
    .all<MemoryCursorRow>();
  return result.results ?? [];
}

async function ensureLegacyMapSynced(
  db: D1Database,
  kind: FtsKind,
  limit: number
): Promise<{ available: boolean; remaining: number; orphansPurged: number }> {
  const mapState = await readMaintenanceState(db, GLOBAL_MAP_SCOPE, kind);
  if (!mapState.available) return { available: false, remaining: limit, orphansPurged: 0 };
  if (Number(mapState.row?.fts_synced ?? 0) === 1) return { available: true, remaining: limit, orphansPurged: 0 };

  const sync = await syncFtsMapPage(db, kind, {
    afterRowId: Number(mapState.row?.fts_sync_rowid ?? 0),
    limit,
    syncMap: true,
    purgeOrphans: true,
    dryRun: false
  });
  await writeMaintenanceState(db, {
    scope: GLOBAL_MAP_SCOPE,
    kind,
    ftsSyncRowId: sync.lastRowId,
    ftsSynced: sync.done ? 1 : 0
  });
  return {
    available: true,
    remaining: sync.done ? Math.max(limit - sync.scanned, 0) : 0,
    orphansPurged: sync.orphansPurged + sync.duplicatesPurged
  };
}

async function backfillMessagesIncremental(
  db: D1Database,
  input: { namespace?: string; limit: number }
): Promise<{ indexed: number; orphansPurged: number; failed: number }> {
  const synced = await ensureLegacyMapSynced(db, "message", input.limit);
  if (!synced.available) return fallbackIndexMissingMessages(db, input);
  if (synced.remaining === 0) return { indexed: 0, orphansPurged: synced.orphansPurged, failed: 0 };

  const scope = input.namespace ?? GLOBAL_CURSOR_SCOPE;
  const cursorState = await readMaintenanceState(db, scope, "message");
  const cursor: KeysetCursor = {
    ts: cursorState.row?.cursor_ts ?? "",
    seq: Number(cursorState.row?.cursor_seq ?? 0),
    id: cursorState.row?.cursor_id ?? ""
  };

  const rows = await fetchMessagesAfterCursor(db, { namespace: input.namespace, cursor, limit: synced.remaining });
  if (rows.length === 0) return { indexed: 0, orphansPurged: synced.orphansPurged, failed: 0 };

  const mapped = await getMappedFtsEntries(db, "message", rows.map((row) => row.id));
  let indexed = 0;
  let failed = 0;
  let advanced: KeysetCursor | null = null;
  let blockedByFailure = false;

  for (const row of rows) {
    if (!mapped.entries.has(row.id)) {
      const outcome = await writeFtsRowWithOutcome(
        db,
        "message",
        { namespace: row.namespace, entityId: row.id, rawText: row.content },
        false
      );
      if (outcome === "indexed") indexed += 1;
      else if (outcome === "failed") {
        failed += 1;
        blockedByFailure = true;
      }
    }
    if (!blockedByFailure) advanced = { ts: row.created_at, seq: Number(row.seq ?? 0), id: row.id };
  }

  if (advanced) {
    await writeMaintenanceState(db, {
      scope,
      kind: "message",
      cursorTs: advanced.ts,
      cursorSeq: advanced.seq,
      cursorId: advanced.id
    });
  }
  return { indexed, orphansPurged: synced.orphansPurged, failed };
}

async function backfillMemoriesIncremental(
  db: D1Database,
  input: { namespace?: string; limit: number }
): Promise<{ indexed: number; orphansPurged: number; failed: number }> {
  const synced = await ensureLegacyMapSynced(db, "memory", input.limit);
  if (!synced.available) return fallbackIndexMissingMemories(db, input);
  if (synced.remaining === 0) return { indexed: 0, orphansPurged: synced.orphansPurged, failed: 0 };

  const scope = input.namespace ?? GLOBAL_CURSOR_SCOPE;
  const cursorState = await readMaintenanceState(db, scope, "memory");
  const cursor: KeysetCursor = {
    ts: cursorState.row?.cursor_ts ?? "",
    seq: 0,
    id: cursorState.row?.cursor_id ?? ""
  };

  const rows = await fetchMemoriesAfterCursor(db, { namespace: input.namespace, cursor, limit: synced.remaining });
  if (rows.length === 0) return { indexed: 0, orphansPurged: synced.orphansPurged, failed: 0 };

  const mapped = await getMappedFtsEntries(db, "memory", rows.map((row) => row.id));
  let indexed = 0;
  let orphansPurged = synced.orphansPurged;
  let failed = 0;
  let advanced: KeysetCursor | null = null;
  let blockedByFailure = false;

  for (const row of rows) {
    const existing = mapped.entries.get(row.id);
    if (row.status === "active") {
      if (!existing || row.updated_at > existing.updated_at) {
        const outcome = await writeFtsRowWithOutcome(
          db,
          "memory",
          { namespace: row.namespace, entityId: row.id, rawText: `${row.content}\n${row.summary ?? ""}` },
          Boolean(existing)
        );
        if (outcome === "indexed") indexed += 1;
        else if (outcome === "failed") {
          failed += 1;
          blockedByFailure = true;
        }
      }
    } else if (existing) {
      await deleteFtsRow(db, "memory_fts", "memory_id", row.id);
      orphansPurged += 1;
    }
    if (!blockedByFailure) advanced = { ts: row.updated_at, seq: 0, id: row.id };
  }

  if (advanced) {
    await writeMaintenanceState(db, {
      scope,
      kind: "memory",
      cursorTs: advanced.ts,
      cursorSeq: 0,
      cursorId: advanced.id
    });
  }
  return { indexed, orphansPurged, failed };
}

// Fallback used only when migration 0031 has not been applied (e.g. minimal unit-test schemas).
async function fallbackIndexMissingMessages(
  db: D1Database,
  input: { namespace?: string; limit: number }
): Promise<{ indexed: number; orphansPurged: number; failed: number }> {
  const scoped = Boolean(input.namespace);
  const sql = scoped
    ? `SELECT m.id, m.namespace, m.content FROM messages m
       WHERE m.namespace = ? AND m.role IN ('user', 'assistant')
         AND m.id NOT IN (SELECT message_id FROM message_fts WHERE message_id IS NOT NULL)
       LIMIT ?`
    : `SELECT m.id, m.namespace, m.content FROM messages m
       WHERE m.role IN ('user', 'assistant')
         AND m.id NOT IN (SELECT message_id FROM message_fts WHERE message_id IS NOT NULL)
       LIMIT ?`;
  const result = scoped
    ? await db.prepare(sql).bind(input.namespace, input.limit).all<{ id: string; namespace: string; content: string }>()
    : await db.prepare(sql).bind(input.limit).all<{ id: string; namespace: string; content: string }>();

  let indexed = 0;
  let failed = 0;
  for (const row of result.results ?? []) {
    const outcome = await writeFtsRowWithOutcome(db, "message", { namespace: row.namespace, entityId: row.id, rawText: row.content }, false);
    if (outcome === "indexed") indexed += 1;
    else if (outcome === "failed") failed += 1;
  }
  return { indexed, orphansPurged: 0, failed };
}

async function fallbackIndexMissingMemories(
  db: D1Database,
  input: { namespace?: string; limit: number }
): Promise<{ indexed: number; orphansPurged: number; failed: number }> {
  const scoped = Boolean(input.namespace);
  const sql = scoped
    ? `SELECT m.id, m.namespace, m.content, m.summary FROM memories m
       WHERE m.namespace = ? AND m.status = 'active'
         AND m.id NOT IN (SELECT memory_id FROM memory_fts WHERE memory_id IS NOT NULL)
       LIMIT ?`
    : `SELECT m.id, m.namespace, m.content, m.summary FROM memories m
       WHERE m.status = 'active'
         AND m.id NOT IN (SELECT memory_id FROM memory_fts WHERE memory_id IS NOT NULL)
       LIMIT ?`;
  const result = scoped
    ? await db.prepare(sql).bind(input.namespace, input.limit).all<{ id: string; namespace: string; content: string; summary: string | null }>()
    : await db.prepare(sql).bind(input.limit).all<{ id: string; namespace: string; content: string; summary: string | null }>();

  let indexed = 0;
  let failed = 0;
  for (const row of result.results ?? []) {
    const outcome = await writeFtsRowWithOutcome(
      db,
      "memory",
      { namespace: row.namespace, entityId: row.id, rawText: `${row.content}\n${row.summary ?? ""}` },
      false
    );
    if (outcome === "indexed") indexed += 1;
    else if (outcome === "failed") failed += 1;
  }
  return { indexed, orphansPurged: 0, failed };
}

/**
 * Bounded orphan purge (one rowid-paginated page per FTS table).
 * Kept for manual / compatibility callers; nightly maintenance uses incremental cursors instead.
 */
export async function purgeOrphanFts(
  db: D1Database,
  input: { limit?: number; afterMessageRowId?: number; afterMemoryRowId?: number; namespace?: string } = {}
): Promise<{
  messages: number;
  memories: number;
  nextMessageRowId: number | null;
  nextMemoryRowId: number | null;
}> {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 200), 1), 1000);
  let messages = 0;
  let memories = 0;
  let nextMessageRowId: number | null = null;
  let nextMemoryRowId: number | null = null;

  try {
    const msg = await syncFtsMapPage(db, "message", {
      afterRowId: input.afterMessageRowId ?? 0,
      limit,
      namespace: input.namespace,
      syncMap: false,
      purgeOrphans: true,
      dryRun: false
    });
    messages = msg.orphansPurged + msg.duplicatesPurged;
    nextMessageRowId = msg.done ? null : msg.lastRowId;
  } catch (error) {
    console.error("message fts orphan purge failed", error);
  }

  try {
    const mem = await syncFtsMapPage(db, "memory", {
      afterRowId: input.afterMemoryRowId ?? 0,
      limit,
      namespace: input.namespace,
      syncMap: false,
      purgeOrphans: true,
      dryRun: false
    });
    memories = mem.orphansPurged + mem.duplicatesPurged;
    nextMemoryRowId = mem.done ? null : mem.lastRowId;
  } catch (error) {
    console.error("memory fts orphan purge failed", error);
  }

  return { messages, memories, nextMessageRowId, nextMemoryRowId };
}

export async function backfillFts(
  db: D1Database,
  input: { namespace?: string; limit?: number } = {}
): Promise<FtsBackfillResult> {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 200), 1), 1000);
  let messagesIndexed = 0;
  let memoriesIndexed = 0;
  let messageOrphansPurged = 0;
  let memoryOrphansPurged = 0;
  let failed = 0;

  try {
    const messages = await backfillMessagesIncremental(db, { namespace: input.namespace, limit });
    messagesIndexed = messages.indexed;
    messageOrphansPurged = messages.orphansPurged;
    failed += messages.failed;
  } catch (error) {
    console.error("message fts backfill failed", error);
  }

  try {
    const memories = await backfillMemoriesIncremental(db, { namespace: input.namespace, limit });
    memoriesIndexed = memories.indexed;
    memoryOrphansPurged = memories.orphansPurged;
    failed += memories.failed;
  } catch (error) {
    console.error("memory fts backfill failed", error);
  }

  return { messagesIndexed, memoriesIndexed, messageOrphansPurged, memoryOrphansPurged, failed };
}

function parseRowIdCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseKeysetCursor(cursor: string | null | undefined): KeysetCursor {
  if (!cursor) return { ts: "", seq: 0, id: "" };
  try {
    const parsed = JSON.parse(cursor) as Partial<KeysetCursor>;
    return {
      ts: typeof parsed.ts === "string" ? parsed.ts : "",
      seq: typeof parsed.seq === "number" && Number.isFinite(parsed.seq) ? parsed.seq : 0,
      id: typeof parsed.id === "string" ? parsed.id : ""
    };
  } catch {
    return { ts: "", seq: 0, id: "" };
  }
}

/**
 * Manual bounded reconciliation entry point for legacy FTS data:
 * - `sync_map`: walks FTS by rowid, populates fts_entry_map, prunes orphans & duplicates.
 * - `purge_orphans`: walks FTS by rowid and prunes orphans & duplicates without backfilling map.
 * - `backfill_missing`: walks messages/memories by ordered cursor and indexes rows absent from fts_entry_map.
 */
export async function reconcileFts(
  db: D1Database,
  input: {
    mode: FtsReconcileMode;
    kind: FtsKind;
    namespace?: string;
    cursor?: string | null;
    limit?: number;
    dryRun?: boolean;
  }
): Promise<FtsReconcileResult> {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 200), 1), 500);
  const dryRun = Boolean(input.dryRun);
  const namespace = input.namespace || undefined;

  if (input.mode === "sync_map" || input.mode === "purge_orphans") {
    const afterRowId = parseRowIdCursor(input.cursor);
    const page = await syncFtsMapPage(db, input.kind, {
      afterRowId,
      limit,
      namespace,
      syncMap: input.mode === "sync_map",
      purgeOrphans: true,
      dryRun
    });

    if (input.mode === "sync_map" && !dryRun && !namespace) {
      const mapState = await readMaintenanceState(db, GLOBAL_MAP_SCOPE, input.kind);
      if (mapState.available) {
        await writeMaintenanceState(db, {
          scope: GLOBAL_MAP_SCOPE,
          kind: input.kind,
          ftsSyncRowId: Math.max(Number(mapState.row?.fts_sync_rowid ?? 0), page.lastRowId),
          ftsSynced: page.done ? 1 : Number(mapState.row?.fts_synced ?? 0)
        });
      }
    }

    return {
      mode: input.mode,
      kind: input.kind,
      namespace: namespace ?? null,
      limit,
      dry_run: dryRun,
      scanned: page.scanned,
      mapped: page.mapped,
      indexed: 0,
      orphans_purged: page.orphansPurged,
      duplicates_purged: page.duplicatesPurged,
      failed: 0,
      next_cursor: page.done ? null : String(page.lastRowId),
      done: page.done
    };
  }

  const cursor = parseKeysetCursor(input.cursor);
  if (input.kind === "message") {
    const rows = await fetchMessagesAfterCursor(db, { namespace, cursor, limit });
    const mapped = await getMappedFtsEntries(db, "message", rows.map((row) => row.id));
    let indexed = 0;
    let failed = 0;
    for (const row of rows) {
      if (mapped.entries.has(row.id)) continue;
      if (dryRun) {
        if (toFtsBody(cleanMessageText(row.content))) indexed += 1;
        continue;
      }
      const outcome = await writeFtsRowWithOutcome(
        db,
        "message",
        { namespace: row.namespace, entityId: row.id, rawText: row.content },
        false
      );
      if (outcome === "indexed") indexed += 1;
      else if (outcome === "failed") failed += 1;
    }
    const done = rows.length < limit;
    const last = rows[rows.length - 1];
    return {
      mode: input.mode,
      kind: input.kind,
      namespace: namespace ?? null,
      limit,
      dry_run: dryRun,
      scanned: rows.length,
      mapped: 0,
      indexed,
      orphans_purged: 0,
      duplicates_purged: 0,
      failed,
      next_cursor: done || !last
        ? null
        : JSON.stringify({ ts: last.created_at, seq: Number(last.seq ?? 0), id: last.id }),
      done
    };
  }

  const rows = await fetchMemoriesAfterCursor(db, { namespace, cursor, limit });
  const mapped = await getMappedFtsEntries(db, "memory", rows.map((row) => row.id));
  let indexed = 0;
  let orphansPurged = 0;
  let failed = 0;
  for (const row of rows) {
    const existing = mapped.entries.get(row.id);
    if (row.status === "active") {
      if (existing) continue;
      const text = `${row.content}\n${row.summary ?? ""}`;
      if (dryRun) {
        if (toFtsBody(text)) indexed += 1;
        continue;
      }
      const outcome = await writeFtsRowWithOutcome(
        db,
        "memory",
        { namespace: row.namespace, entityId: row.id, rawText: text },
        false
      );
      if (outcome === "indexed") indexed += 1;
      else if (outcome === "failed") failed += 1;
    } else if (existing) {
      orphansPurged += 1;
      if (!dryRun) await deleteFtsRow(db, "memory_fts", "memory_id", row.id);
    }
  }
  const done = rows.length < limit;
  const last = rows[rows.length - 1];
  return {
    mode: input.mode,
    kind: input.kind,
    namespace: namespace ?? null,
    limit,
    dry_run: dryRun,
    scanned: rows.length,
    mapped: 0,
    indexed,
    orphans_purged: orphansPurged,
    duplicates_purged: 0,
    failed,
    next_cursor: done || !last ? null : JSON.stringify({ ts: last.updated_at, seq: 0, id: last.id }),
    done
  };
}

async function clearNamespaceMappedFts(db: D1Database, kind: FtsKind, namespace: string): Promise<boolean> {
  const spec = FTS_SPECS[kind];
  try {
    let lastRowId = 0;
    for (;;) {
      const page = await db
        .prepare(
          `SELECT entity_id, fts_rowid
           FROM fts_entry_map
           WHERE kind = ? AND namespace = ? AND fts_rowid > ?
           ORDER BY fts_rowid ASC
           LIMIT ?`
        )
        .bind(kind, namespace, lastRowId, FTS_BATCH_SIZE)
        .all<{ entity_id: string; fts_rowid: number }>();
      const rows = page.results ?? [];
      if (rows.length === 0) break;
      lastRowId = Number(rows[rows.length - 1].fts_rowid);
      const rowIds = rows.map((row) => Number(row.fts_rowid));
      const placeholders = rowIds.map(() => "?").join(", ");
      await db.prepare(`DELETE FROM ${spec.table} WHERE rowid IN (${placeholders})`).bind(...rowIds).run();
      await deleteMappedFtsEntries(db, kind, rows.map((row) => row.entity_id));
      if (rows.length < FTS_BATCH_SIZE) break;
    }
    return true;
  } catch (error) {
    if (isMissingFtsStateError(error)) return false;
    throw error;
  }
}

export async function rebuildFts(
  db: D1Database,
  input: { namespace?: string; limit?: number } = {}
): Promise<FtsBackfillResult> {
  try {
    if (input.namespace) {
      for (const kind of ["message", "memory"] as const) {
        const spec = FTS_SPECS[kind];
        const mapAvailable = await clearNamespaceMappedFts(db, kind, input.namespace);
        if (!mapAvailable || !await isFtsMapSynced(db, kind)) {
          await db.prepare(`DELETE FROM ${spec.table} WHERE namespace = ?`).bind(input.namespace).run();
        }
        if (mapAvailable) {
          await writeMaintenanceState(db, {
            scope: input.namespace,
            kind,
            cursorTs: "",
            cursorSeq: 0,
            cursorId: ""
          });
        }
      }
    } else {
      await db.prepare("DELETE FROM message_fts").run();
      await db.prepare("DELETE FROM memory_fts").run();
      try {
        await db.prepare("DELETE FROM fts_entry_map").run();
        await db.prepare("DELETE FROM fts_maintenance_state").run();
        await writeMaintenanceState(db, { scope: GLOBAL_MAP_SCOPE, kind: "message", ftsSyncRowId: 0, ftsSynced: 1 });
        await writeMaintenanceState(db, { scope: GLOBAL_MAP_SCOPE, kind: "memory", ftsSyncRowId: 0, ftsSynced: 1 });
      } catch (error) {
        if (!isMissingFtsStateError(error)) throw error;
      }
    }
  } catch (error) {
    console.error("fts rebuild truncate failed", error);
  }
  return backfillFts(db, input);
}
