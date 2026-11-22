import { cleanMessageText } from "../utils/sanitize";
import { tokenizeForIndex } from "./queryShape";
import {
  deleteMappedFtsEntries,
  FTS_BATCH_SIZE,
  FTS_SPECS,
  type FtsIdColumn,
  type FtsKind,
  type FtsTable,
  getMappedFtsEntries,
  getMappedFtsEntry,
  isFtsMapSynced,
  isMissingFtsError,
  recordMappedFtsEntry,
  resolveInsertedRowId,
  specForTable
} from "./ftsState";

export type { FtsIdColumn, FtsKind, FtsTable } from "./ftsState";
export {
  backfillFts,
  type FtsBackfillResult,
  type FtsReconcileMode,
  type FtsReconcileResult,
  purgeOrphanFts,
  rebuildFts,
  reconcileFts
} from "./ftsMaintenance";

const FTS_WRITE_ATTEMPTS = 3;

export type WriteFtsOutcome = "indexed" | "empty" | "failed";

export function toFtsBody(text: string): string {
  return tokenizeForIndex(text).join(" ");
}

export function toFtsMatch(tokens: string[]): string {
  const unique = [...new Set(tokens.map((token) => token.trim().toLowerCase()).filter((token) => token.length >= 2))];
  return unique
    .map((token) => `"${token.replace(/["*]/g, "")}"`)
    .filter((token) => token.length > 2)
    .slice(0, 12)
    .join(" OR ");
}

async function withRetry<T>(fn: () => Promise<T>, label: string, meta: Record<string, unknown>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < FTS_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (isMissingFtsError(error) || attempt === FTS_WRITE_ATTEMPTS - 1) {
        if (!isMissingFtsError(error)) console.error(label, { ...meta, attempt: attempt + 1, error });
        break;
      }
    }
  }
  throw last;
}

export async function deleteFtsRow(
  db: D1Database,
  table: FtsTable,
  idColumn: FtsIdColumn,
  id: string
): Promise<void> {
  const spec = specForTable(table);
  try {
    const mapped = await getMappedFtsEntry(db, spec.kind, id);
    if (mapped.available && mapped.entry) {
      const ftsRowId = mapped.entry.fts_rowid;
      await withRetry(
        async () => {
          await db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).bind(ftsRowId).run();
          await deleteMappedFtsEntries(db, spec.kind, [id]);
        },
        "fts delete by rowid failed",
        { table, id, ftsRowId }
      );
      return;
    }
    if (mapped.available && await isFtsMapSynced(db, spec.kind)) {
      return;
    }
    await withRetry(
      () => db.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`).bind(id).run(),
      "fts delete failed",
      { table, id }
    );
  } catch {
    // Search already falls back to LIKE; a stale row is worse than a missing one only if content changed.
  }
}

export async function deleteFtsRowsByIds(
  db: D1Database,
  table: FtsTable,
  idColumn: FtsIdColumn,
  ids: string[]
): Promise<void> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return;
  const spec = specForTable(table);
  try {
    const mapped = await getMappedFtsEntries(db, spec.kind, unique);
    if (mapped.available) {
      const mappedIds: string[] = [];
      const rowIds: number[] = [];
      const unmappedIds: string[] = [];
      for (const id of unique) {
        const entry = mapped.entries.get(id);
        if (entry) {
          mappedIds.push(id);
          rowIds.push(entry.fts_rowid);
        } else {
          unmappedIds.push(id);
        }
      }
      for (let index = 0; index < rowIds.length; index += FTS_BATCH_SIZE) {
        const batch = rowIds.slice(index, index + FTS_BATCH_SIZE);
        const placeholders = batch.map(() => "?").join(", ");
        await withRetry(
          () => db.prepare(`DELETE FROM ${table} WHERE rowid IN (${placeholders})`).bind(...batch).run(),
          "fts batch delete by rowid failed",
          { table, count: batch.length }
        );
      }
      if (mappedIds.length > 0) {
        await deleteMappedFtsEntries(db, spec.kind, mappedIds);
      }
      if (unmappedIds.length === 0 || await isFtsMapSynced(db, spec.kind)) {
        return;
      }
      for (let index = 0; index < unmappedIds.length; index += FTS_BATCH_SIZE) {
        const batch = unmappedIds.slice(index, index + FTS_BATCH_SIZE);
        const placeholders = batch.map(() => "?").join(", ");
        await withRetry(
          () => db.prepare(`DELETE FROM ${table} WHERE ${idColumn} IN (${placeholders})`).bind(...batch).run(),
          "fts legacy batch delete failed",
          { table, count: batch.length }
        );
      }
      return;
    }

    for (let index = 0; index < unique.length; index += FTS_BATCH_SIZE) {
      const batch = unique.slice(index, index + FTS_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(", ");
      await withRetry(
        () => db.prepare(`DELETE FROM ${table} WHERE ${idColumn} IN (${placeholders})`).bind(...batch).run(),
        "fts batch delete failed",
        { table, count: batch.length }
      );
    }
  } catch (error) {
    if (!isMissingFtsError(error)) {
      console.error("fts batch delete failed", { table, count: unique.length, error });
    }
  }
}

// message_id / memory_id are UNINDEXED in FTS5, so `DELETE ... WHERE message_id = ?` reads
// every row of the FTS table (D1 bills each one). We store `(kind, entity_id) -> fts_rowid`
// in fts_entry_map so updates and deletes use O(log N) `WHERE rowid = ?` point deletes,
// and insert-only paths skip deletion altogether.
export async function writeFtsRowWithOutcome(
  db: D1Database,
  kind: FtsKind,
  input: { namespace: string; entityId: string; rawText: string },
  replace: boolean
): Promise<WriteFtsOutcome> {
  const spec = FTS_SPECS[kind];
  const body = toFtsBody(kind === "message" ? cleanMessageText(input.rawText) : input.rawText);
  if (!body) {
    if (replace) await deleteFtsRow(db, spec.table, spec.idColumn, input.entityId);
    return "empty";
  }
  try {
    if (replace) {
      await deleteFtsRow(db, spec.table, spec.idColumn, input.entityId);
    }
    const inserted = await withRetry(
      () =>
        db
          .prepare(`INSERT INTO ${spec.table} (fts_body, namespace, ${spec.idColumn}) VALUES (?, ?, ?)`)
          .bind(body, input.namespace, input.entityId)
          .run(),
      `${kind} fts index failed`,
      { id: input.entityId }
    );
    const ftsRowId = await resolveInsertedRowId(db, inserted);
    if (ftsRowId !== null) {
      await recordMappedFtsEntry(db, {
        kind,
        entityId: input.entityId,
        namespace: input.namespace,
        ftsRowId
      });
    }
    return "indexed";
  } catch (error) {
    if (!isMissingFtsError(error)) console.error(`${kind} fts index failed`, { id: input.entityId, error });
    return "failed";
  }
}

/** Re-index a message that may already have an FTS row (point delete via fts_entry_map). */
export async function upsertMessageFts(
  db: D1Database,
  input: { namespace: string; messageId: string; content: string }
): Promise<boolean> {
  return (await writeFtsRowWithOutcome(db, "message", { namespace: input.namespace, entityId: input.messageId, rawText: input.content }, true)) === "indexed";
}

/** Index a message row that has no FTS row yet (just inserted, or found missing by backfill). */
export async function insertMessageFts(
  db: D1Database,
  input: { namespace: string; messageId: string; content: string }
): Promise<boolean> {
  return (await writeFtsRowWithOutcome(db, "message", { namespace: input.namespace, entityId: input.messageId, rawText: input.content }, false)) === "indexed";
}

/** Re-index a memory that may already have an FTS row (point delete via fts_entry_map). */
export async function upsertMemoryFts(
  db: D1Database,
  input: { namespace: string; memoryId: string; content: string }
): Promise<boolean> {
  return (await writeFtsRowWithOutcome(db, "memory", { namespace: input.namespace, entityId: input.memoryId, rawText: input.content }, true)) === "indexed";
}

/** Index a newly created memory row that has no FTS row yet. */
export async function insertMemoryFts(
  db: D1Database,
  input: { namespace: string; memoryId: string; content: string }
): Promise<boolean> {
  return (await writeFtsRowWithOutcome(db, "memory", { namespace: input.namespace, entityId: input.memoryId, rawText: input.content }, false)) === "indexed";
}

export async function searchFtsIds(
  db: D1Database,
  table: FtsTable,
  idColumn: FtsIdColumn,
  input: { namespace: string; tokens: string[]; limit: number }
): Promise<string[]> {
  const match = toFtsMatch(input.tokens);
  if (!match) return [];
  try {
    const result = await db
      .prepare(
        `SELECT ${idColumn} AS id FROM ${table}
         WHERE ${table} MATCH ? AND namespace = ?
         ORDER BY bm25(${table})
         LIMIT ?`
      )
      .bind(match, input.namespace, input.limit)
      .all<{ id: string }>();
    return (result.results ?? []).map((row) => row.id).filter(Boolean);
  } catch (rankedError) {
    if (isMissingFtsError(rankedError)) return [];
    try {
      const result = await db
        .prepare(
          `SELECT ${idColumn} AS id FROM ${table}
           WHERE ${table} MATCH ? AND namespace = ?
           LIMIT ?`
        )
        .bind(match, input.namespace, input.limit)
        .all<{ id: string }>();
      return (result.results ?? []).map((row) => row.id).filter(Boolean);
    } catch (error) {
      if (!isMissingFtsError(error)) console.error("fts search failed", { table, error, rankedError });
      return [];
    }
  }
}
