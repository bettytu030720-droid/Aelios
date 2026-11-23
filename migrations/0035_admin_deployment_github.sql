CREATE TABLE admin_deployment_github (
  deployment TEXT PRIMARY KEY NOT NULL,
  repository_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  state TEXT,
  browser_proof TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,
  app_enc TEXT,
  installation_id INTEGER
);

ALTER TABLE admin_deployment_update ADD COLUMN github_token_enc TEXT;
