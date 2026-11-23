-- One active update per deployment. A compare-and-swap on attempt_id serializes clicks.
CREATE TABLE admin_deployment_update (
  deployment TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL,
  start_commit TEXT NOT NULL,
  target_commit TEXT,
  started_at INTEGER NOT NULL,
  hook_started_at INTEGER,
  failure TEXT
);
