-- Bounded admin read paths (#137):
-- 1) Materialized per-namespace active memory counts by type, kept exact by triggers
--    so /v1/memory_boot and /api/relations/graph never scan all memories to count.
-- 2) Ordered covering indexes for /v1/memory, /api/relations/graph, and scoped decisions
--    so small-limit page queries read O(limit) rows instead of scanning the full table.

CREATE TABLE IF NOT EXISTS memory_type_counts (
  namespace TEXT NOT NULL,
  type TEXT NOT NULL,
  active_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, type)
);

INSERT INTO memory_type_counts (namespace, type, active_count)
SELECT namespace, type, COUNT(*)
FROM memories
WHERE status = 'active'
GROUP BY namespace, type
ON CONFLICT(namespace, type) DO UPDATE SET active_count = excluded.active_count;

CREATE TRIGGER IF NOT EXISTS trg_memories_type_count_ins
AFTER INSERT ON memories
WHEN NEW.status = 'active'
BEGIN
  INSERT INTO memory_type_counts (namespace, type, active_count)
  VALUES (NEW.namespace, NEW.type, 1)
  ON CONFLICT(namespace, type) DO UPDATE SET active_count = active_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_memories_type_count_del
AFTER DELETE ON memories
WHEN OLD.status = 'active'
BEGIN
  UPDATE memory_type_counts
  SET active_count = MAX(0, active_count - 1)
  WHERE namespace = OLD.namespace AND type = OLD.type;
END;

CREATE TRIGGER IF NOT EXISTS trg_memories_type_count_upd_dec
AFTER UPDATE OF namespace, status, type ON memories
WHEN OLD.status = 'active'
  AND (NEW.status != 'active' OR NEW.namespace != OLD.namespace OR NEW.type != OLD.type)
BEGIN
  UPDATE memory_type_counts
  SET active_count = MAX(0, active_count - 1)
  WHERE namespace = OLD.namespace AND type = OLD.type;
END;

CREATE TRIGGER IF NOT EXISTS trg_memories_type_count_upd_inc
AFTER UPDATE OF namespace, status, type ON memories
WHEN NEW.status = 'active'
  AND (OLD.status != 'active' OR NEW.namespace != OLD.namespace OR NEW.type != OLD.type)
BEGIN
  INSERT INTO memory_type_counts (namespace, type, active_count)
  VALUES (NEW.namespace, NEW.type, 1)
  ON CONFLICT(namespace, type) DO UPDATE SET active_count = active_count + 1;
END;

CREATE INDEX IF NOT EXISTS idx_memories_list_order
ON memories (namespace, status, pinned DESC, importance DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_list_type_order
ON memories (namespace, status, type, pinned DESC, importance DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_graph_order
ON memories (namespace, status, importance DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_scoped_decisions
ON memories (namespace, status, type, source);
