-- Bounded admin read follow-ups (#140, #141, #142):
-- 1) #140: Covering (src_id, dst_id, rel_type, weight) index on memory_relations
--    so /api/relations/graph filters both endpoints in SQL without scanning out-of-page edges.
-- 2) #141: Trigger-maintained count tables for memory_candidates (by namespace, status, source)
--    and user/assistant messages (by namespace, UTC hour bucket) so /v1/memory_boot stays bounded.
-- 3) #142: Keyset pagination indexes on memories with id DESC tie-breaker so deep pages
--    seek directly instead of scanning OFFSET rows.

-- #140: Relations covering index for paired endpoint lookup
CREATE INDEX IF NOT EXISTS idx_memory_relations_src_dst_cover
ON memory_relations (src_id, dst_id, rel_type, weight);

-- #141a: Materialized memory_candidates counts
CREATE TABLE IF NOT EXISTS memory_candidate_counts (
  namespace TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, status, source)
);

INSERT INTO memory_candidate_counts (namespace, status, source, row_count)
SELECT namespace, status, source, COUNT(*)
FROM memory_candidates
GROUP BY namespace, status, source
ON CONFLICT(namespace, status, source) DO UPDATE SET row_count = excluded.row_count;

CREATE TRIGGER IF NOT EXISTS trg_memory_candidates_count_ins
AFTER INSERT ON memory_candidates
BEGIN
  INSERT INTO memory_candidate_counts (namespace, status, source, row_count)
  VALUES (NEW.namespace, NEW.status, NEW.source, 1)
  ON CONFLICT(namespace, status, source) DO UPDATE SET row_count = row_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_candidates_count_del
AFTER DELETE ON memory_candidates
BEGIN
  UPDATE memory_candidate_counts
  SET row_count = MAX(0, row_count - 1)
  WHERE namespace = OLD.namespace AND status = OLD.status AND source = OLD.source;
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_candidates_count_upd_dec
AFTER UPDATE OF namespace, status, source ON memory_candidates
WHEN NEW.namespace != OLD.namespace OR NEW.status != OLD.status OR NEW.source != OLD.source
BEGIN
  UPDATE memory_candidate_counts
  SET row_count = MAX(0, row_count - 1)
  WHERE namespace = OLD.namespace AND status = OLD.status AND source = OLD.source;
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_candidates_count_upd_inc
AFTER UPDATE OF namespace, status, source ON memory_candidates
WHEN NEW.namespace != OLD.namespace OR NEW.status != OLD.status OR NEW.source != OLD.source
BEGIN
  INSERT INTO memory_candidate_counts (namespace, status, source, row_count)
  VALUES (NEW.namespace, NEW.status, NEW.source, 1)
  ON CONFLICT(namespace, status, source) DO UPDATE SET row_count = row_count + 1;
END;

-- #141b: Materialized user/assistant message counts per UTC hour bucket
-- Plus ordered partial index matching MESSAGE_ORDER_SQL so /v1/memory_boot's
-- 160-row slice reads O(limit) rows instead of sorting all matching messages.
CREATE INDEX IF NOT EXISTS idx_messages_namespace_range_order
ON messages (
  namespace,
  created_at ASC,
  seq ASC,
  CASE role WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END ASC,
  id ASC
)
WHERE role IN ('user', 'assistant');

CREATE TABLE IF NOT EXISTS message_hour_counts (
  namespace TEXT NOT NULL,
  hour_bucket TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, hour_bucket)
);

INSERT INTO message_hour_counts (namespace, hour_bucket, row_count)
SELECT namespace, substr(created_at, 1, 13), COUNT(*)
FROM messages
WHERE role IN ('user', 'assistant')
GROUP BY namespace, substr(created_at, 1, 13)
ON CONFLICT(namespace, hour_bucket) DO UPDATE SET row_count = excluded.row_count;

CREATE TRIGGER IF NOT EXISTS trg_messages_hour_count_ins
AFTER INSERT ON messages
WHEN NEW.role IN ('user', 'assistant')
BEGIN
  INSERT INTO message_hour_counts (namespace, hour_bucket, row_count)
  VALUES (NEW.namespace, substr(NEW.created_at, 1, 13), 1)
  ON CONFLICT(namespace, hour_bucket) DO UPDATE SET row_count = row_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_hour_count_del
AFTER DELETE ON messages
WHEN OLD.role IN ('user', 'assistant')
BEGIN
  UPDATE message_hour_counts
  SET row_count = MAX(0, row_count - 1)
  WHERE namespace = OLD.namespace AND hour_bucket = substr(OLD.created_at, 1, 13);
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_hour_count_upd_dec
AFTER UPDATE OF namespace, role, created_at ON messages
WHEN OLD.role IN ('user', 'assistant')
  AND (
    NEW.role NOT IN ('user', 'assistant')
    OR NEW.namespace != OLD.namespace
    OR substr(NEW.created_at, 1, 13) != substr(OLD.created_at, 1, 13)
  )
BEGIN
  UPDATE message_hour_counts
  SET row_count = MAX(0, row_count - 1)
  WHERE namespace = OLD.namespace AND hour_bucket = substr(OLD.created_at, 1, 13);
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_hour_count_upd_inc
AFTER UPDATE OF namespace, role, created_at ON messages
WHEN NEW.role IN ('user', 'assistant')
  AND (
    OLD.role NOT IN ('user', 'assistant')
    OR NEW.namespace != OLD.namespace
    OR substr(NEW.created_at, 1, 13) != substr(OLD.created_at, 1, 13)
  )
BEGIN
  INSERT INTO message_hour_counts (namespace, hour_bucket, row_count)
  VALUES (NEW.namespace, substr(NEW.created_at, 1, 13), 1)
  ON CONFLICT(namespace, hour_bucket) DO UPDATE SET row_count = row_count + 1;
END;

-- #142: Keyset pagination indexes with id DESC tie-breaker
CREATE INDEX IF NOT EXISTS idx_memories_list_keyset
ON memories (namespace, status, pinned DESC, importance DESC, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_memories_list_type_keyset
ON memories (namespace, status, type, pinned DESC, importance DESC, updated_at DESC, id DESC);
