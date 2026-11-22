import { nowIso } from "../utils/time";

// D1 allows at most 100 bound parameters per statement. Keep IN batches <= 90 so
// a leading kind/namespace param still leaves headroom.
export const FTS_BATCH_SIZE = 90;
export const GLOBAL_MAP_SCOPE = "__map__";
export const GLOBAL_CURSOR_SCOPE = "*";

export type FtsKind = "message" | "memory";
export type FtsTable = "message_fts" | "memory_fts";
export type FtsIdColumn = "message_id" | "memory_id";

export interface FtsSpec {
  kind: FtsKind;
  table: FtsTable;
  idColumn: FtsIdColumn;
}

export const FTS_SPECS: Record<FtsKind, FtsSpec> = {
  message: { kind: "message", table: "message_fts", idColumn: "message_id" },
  memory: { kind: "memory", table: "memory_fts", idColumn: "memory_id" }
};

export function specForTable(table: FtsTable): FtsSpec {
  return table === "message_fts" ? FTS_SPECS.message : FTS_SPECS.memory;
}

export function isMissingFtsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (table|module)|fts5/i.test(message);
}

export function isMissingFtsStateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:\s*(fts_entry_map|fts_maintenance_state)/i.test(message);
}

export async function resolveInsertedRowId(db: D1Database, result: D1Result | undefined): Promise<number | null> {
  const meta = result?.meta as { last_row_id?: number; lastInsertRowid?: number | bigint } | undefined;
  const raw = meta?.last_row_id ?? meta?.lastInsertRowid;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "bigint" && raw > 0n) return Number(raw);
  try {
    const row = await db.prepare("SELECT last_insert_rowid() AS id").first<{ id: number | bigint }>();
    const fallback = row?.id;
    if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) return fallback;
    if (typeof fallback === "bigint" && fallback > 0n) return Number(fallback);
  } catch {
    // Ignore when the DB adapter does not expose last_insert_rowid().
  }
  return null;
}

export interface MappedFtsEntry {
  entity_id: string;
  fts_rowid: number;
  updated_at: string;
}

export async function getMappedFtsEntry(
  db: D1Database,
  kind: FtsKind,
  entityId: string
): Promise<{ available: boolean; entry: MappedFtsEntry | null }> {
  try {
    const row = await db
      .prepare("SELECT entity_id, fts_rowid, updated_at FROM fts_entry_map WHERE kind = ? AND entity_id = ?")
      .bind(kind, entityId)
      .first<MappedFtsEntry>();
    return { available: true, entry: row ?? null };
  } catch (error) {
    if (isMissingFtsStateError(error)) return { available: false, entry: null };
    throw error;
  }
}

export async function getMappedFtsEntries(
  db: D1Database,
  kind: FtsKind,
  entityIds: string[]
): Promise<{ available: boolean; entries: Map<string, MappedFtsEntry> }> {
  const unique = [...new Set(entityIds.filter(Boolean))];
  const entries = new Map<string, MappedFtsEntry>();
  if (unique.length === 0) return { available: true, entries };
  try {
    for (let index = 0; index < unique.length; index += FTS_BATCH_SIZE) {
      const batch = unique.slice(index, index + FTS_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(", ");
      const result = await db
        .prepare(
          `SELECT entity_id, fts_rowid, updated_at
           FROM fts_entry_map
           WHERE kind = ? AND entity_id IN (${placeholders})`
        )
        .bind(kind, ...batch)
        .all<MappedFtsEntry>();
      for (const row of result.results ?? []) {
        entries.set(row.entity_id, row);
      }
    }
    return { available: true, entries };
  } catch (error) {
    if (isMissingFtsStateError(error)) return { available: false, entries };
    throw error;
  }
}

export async function recordMappedFtsEntry(
  db: D1Database,
  input: { kind: FtsKind; entityId: string; namespace: string; ftsRowId: number; updatedAt?: string }
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO fts_entry_map (kind, entity_id, namespace, fts_rowid, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, entity_id) DO UPDATE SET
           namespace = excluded.namespace,
           fts_rowid = excluded.fts_rowid,
           updated_at = excluded.updated_at`
      )
      .bind(input.kind, input.entityId, input.namespace, input.ftsRowId, input.updatedAt ?? nowIso())
      .run();
  } catch (error) {
    if (!isMissingFtsStateError(error)) {
      console.error("fts map upsert failed", { kind: input.kind, id: input.entityId, error });
    }
  }
}

export async function deleteMappedFtsEntries(db: D1Database, kind: FtsKind, entityIds: string[]): Promise<void> {
  const unique = [...new Set(entityIds.filter(Boolean))];
  if (unique.length === 0) return;
  try {
    for (let index = 0; index < unique.length; index += FTS_BATCH_SIZE) {
      const batch = unique.slice(index, index + FTS_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(", ");
      await db
        .prepare(`DELETE FROM fts_entry_map WHERE kind = ? AND entity_id IN (${placeholders})`)
        .bind(kind, ...batch)
        .run();
    }
  } catch (error) {
    if (!isMissingFtsStateError(error)) {
      console.error("fts map delete failed", { kind, count: unique.length, error });
    }
  }
}

export interface MaintenanceStateRow {
  scope: string;
  kind: FtsKind;
  cursor_ts: string;
  cursor_seq: number;
  cursor_id: string;
  fts_sync_rowid: number;
  fts_synced: number;
  updated_at: string;
}

export async function readMaintenanceState(
  db: D1Database,
  scope: string,
  kind: FtsKind
): Promise<{ available: boolean; row: MaintenanceStateRow | null }> {
  try {
    const row = await db
      .prepare(
        `SELECT scope, kind, cursor_ts, cursor_seq, cursor_id, fts_sync_rowid, fts_synced, updated_at
         FROM fts_maintenance_state
         WHERE scope = ? AND kind = ?`
      )
      .bind(scope, kind)
      .first<MaintenanceStateRow>();
    return { available: true, row: row ?? null };
  } catch (error) {
    if (isMissingFtsStateError(error)) return { available: false, row: null };
    throw error;
  }
}

export async function writeMaintenanceState(
  db: D1Database,
  input: {
    scope: string;
    kind: FtsKind;
    cursorTs?: string;
    cursorSeq?: number;
    cursorId?: string;
    ftsSyncRowId?: number;
    ftsSynced?: number;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fts_maintenance_state (
         scope, kind, cursor_ts, cursor_seq, cursor_id, fts_sync_rowid, fts_synced, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, kind) DO UPDATE SET
         cursor_ts = excluded.cursor_ts,
         cursor_seq = excluded.cursor_seq,
         cursor_id = excluded.cursor_id,
         fts_sync_rowid = excluded.fts_sync_rowid,
         fts_synced = excluded.fts_synced,
         updated_at = excluded.updated_at`
    )
    .bind(
      input.scope,
      input.kind,
      input.cursorTs ?? "",
      input.cursorSeq ?? 0,
      input.cursorId ?? "",
      input.ftsSyncRowId ?? 0,
      input.ftsSynced ?? 0,
      nowIso()
    )
    .run();
}

export async function isFtsMapSynced(db: D1Database, kind: FtsKind): Promise<boolean> {
  const state = await readMaintenanceState(db, GLOBAL_MAP_SCOPE, kind);
  return state.available && Number(state.row?.fts_synced ?? 0) === 1;
}
