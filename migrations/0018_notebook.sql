-- 小本本：助手按页名读写的笔记 (MCP notebook 工具，面板「更多 → 小本本」)
--
-- 用来记一直在改的东西，比如备考进度：哪几章做完了、哪里薄弱、下一步做什么。
-- 不放进 memories：那边同一个 fact_key 再写会换新 id、丢置顶，夜里 dream 会改写或归档，
-- 180 天没动会过期，还会被召回和网关注入带进对话。一页一行，按 (namespace, name) 读写。
-- dream、retention、recall 都不扫这张表；页只在本人或助手删掉、或在面板上全部清空时才没。
-- 页名 1-60 字，正文最多 2 万字，每个空间最多 50 页，由 src/db/v2/notebook.ts 把关。

CREATE TABLE IF NOT EXISTS notebook_pages (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(namespace, name)
);
