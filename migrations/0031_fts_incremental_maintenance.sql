-- Incremental FTS maintenance: rowid lookup map for O(log N) point deletes/updates,
-- per-scope cursors for bounded nightly catch-up, and partial/ordered indexes so
-- no-change and LIMIT-1 maintenance never scans historical rows.

CREATE TABLE IF NOT EXISTS fts_entry_map (
  kind TEXT NOT NULL CHECK(kind IN ('message', 'memory')),
  entity_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  fts_rowid INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_fts_entry_map_kind_ns_rowid
ON fts_entry_map (kind, namespace, fts_rowid);

CREATE INDEX IF NOT EXISTS idx_fts_entry_map_kind_rowid
ON fts_entry_map (kind, fts_rowid);

CREATE TABLE IF NOT EXISTS fts_maintenance_state (
  scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('message', 'memory')),
  cursor_ts TEXT NOT NULL DEFAULT '',
  cursor_seq INTEGER NOT NULL DEFAULT 0,
  cursor_id TEXT NOT NULL DEFAULT '',
  fts_sync_rowid INTEGER NOT NULL DEFAULT 0,
  fts_synced INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, kind)
);

CREATE INDEX IF NOT EXISTS idx_messages_fts_cursor
ON messages (namespace, created_at, seq, id)
WHERE role IN ('user', 'assistant');

CREATE INDEX IF NOT EXISTS idx_messages_fts_cursor_all
ON messages (created_at, seq, id)
WHERE role IN ('user', 'assistant');

CREATE INDEX IF NOT EXISTS idx_memories_fts_cursor
ON memories (namespace, updated_at, id);

CREATE INDEX IF NOT EXISTS idx_memories_fts_cursor_all
ON memories (updated_at, id);
