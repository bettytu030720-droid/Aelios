-- ChatGPT 套餐登录 (Sign in with ChatGPT)：用咲咲自己的 ChatGPT 套餐额度跑 chatgpt/<模型>。
--
-- 一个 Aelios 部署只连主人自己的一个账号，所以 chatgpt_connection 永远只有 id=1 一行。
-- access / refresh / id token 在写进来之前就已经用 CHATBOX_API_KEY 派生的密钥加密过 (src/chatgpt/store.ts)，
-- 库里只有密文；主密钥换了就解不开，当作要重新登录。
-- refresh token 每刷新一次就换新的、旧的作废，所以刷新要先抢 refresh_lease_until 这把租约再动手；
-- 租约带 refresh_lease_owner，只有抢到的那次能放；refresh_retry_at 是刷新失败后到什么时候之前不再去打 ChatGPT。
-- 时间列 (access_expires_at 等) 是毫秒时间戳，租约比较用整数最省事。
-- chatgpt_login_pending 存登录进行中的 state / verifier / nonce，10 分钟有效，用一次就删。

CREATE TABLE IF NOT EXISTS chatgpt_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ext_agent_host_id TEXT NOT NULL,
  client_id TEXT,
  subject TEXT,
  email TEXT,
  scopes TEXT NOT NULL DEFAULT '',
  plan_usage INTEGER NOT NULL DEFAULT 0,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  id_token_enc TEXT,
  access_expires_at INTEGER,
  earliest_refresh_at INTEGER,
  refreshed_at INTEGER,
  refresh_lease_until INTEGER,
  refresh_lease_owner TEXT,
  refresh_retry_at INTEGER,
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected', 'connected', 'plan_disabled', 'needs_login')),
  last_error TEXT,
  welcomed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chatgpt_login_pending (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('register', 'reauth')),
  created_at INTEGER NOT NULL
);
