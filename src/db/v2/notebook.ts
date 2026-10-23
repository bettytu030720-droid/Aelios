import { newId } from "../../utils/ids";
import { nowIso } from "../../utils/time";

// =====================================================================
// 小本本 notebook：按页名读写的笔记。表见 migrations/0018_notebook.sql。
// 不进向量库、不进召回；dream 和 retention 都不碰这张表。
// =====================================================================

export const NOTEBOOK_NAME_MAX = 60;
export const NOTEBOOK_CONTENT_MAX = 20000;
export const NOTEBOOK_PAGE_LIMIT = 50;

export interface NotebookPageRow {
  id: string;
  namespace: string;
  name: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface NotebookPageSummary {
  id: string;
  name: string;
  size: number;
  updated_at: string;
}

// 超限、重名：调用方把 message 原样交给对方。
export class NotebookError extends Error {}

// 另一边刚好同时建了同名的页：插入撞上 UNIQUE(namespace, name)。
function isNameClash(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

// 按字符数，和 SQLite 的 length() 一致。
function charCount(text: string): number {
  return Array.from(text).length;
}

function cleanName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// 页名去头尾空白，中间连续空白并成一个空格，1-60 字。
export function normalizeNotebookName(value: string): string {
  const name = cleanName(value);
  if (!name) throw new NotebookError("name is required");
  if (charCount(name) > NOTEBOOK_NAME_MAX) {
    throw new NotebookError(`Page name is too long; keep it to ${NOTEBOOK_NAME_MAX} characters`);
  }
  return name;
}

function checkContent(content: string): void {
  const size = charCount(content);
  if (size > NOTEBOOK_CONTENT_MAX) {
    throw new NotebookError(`Page is too long (${size} characters); a page holds at most ${NOTEBOOK_CONTENT_MAX}`);
  }
}

export async function listNotebookPages(db: D1Database, input: { namespace: string }): Promise<NotebookPageSummary[]> {
  const result = await db
    .prepare(
      `SELECT id, name, length(content) AS size, updated_at FROM notebook_pages
       WHERE namespace = ? ORDER BY updated_at DESC, name`
    )
    .bind(input.namespace)
    .all<NotebookPageSummary>();
  return result.results ?? [];
}

export async function getNotebookPage(
  db: D1Database,
  input: { namespace: string; name: string }
): Promise<NotebookPageRow | null> {
  return db
    .prepare("SELECT * FROM notebook_pages WHERE namespace = ? AND name = ?")
    .bind(input.namespace, cleanName(input.name))
    .first<NotebookPageRow>();
}

export async function getNotebookPageById(
  db: D1Database,
  input: { namespace: string; id: string }
): Promise<NotebookPageRow | null> {
  return db
    .prepare("SELECT * FROM notebook_pages WHERE namespace = ? AND id = ?")
    .bind(input.namespace, input.id)
    .first<NotebookPageRow>();
}

async function insertPage(db: D1Database, namespace: string, name: string, content: string): Promise<NotebookPageRow> {
  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM notebook_pages WHERE namespace = ?")
    .bind(namespace)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= NOTEBOOK_PAGE_LIMIT) {
    throw new NotebookError(`The notebook is full (${NOTEBOOK_PAGE_LIMIT} pages); delete a page you no longer need first`);
  }
  const now = nowIso();
  const page: NotebookPageRow = { id: newId("nb"), namespace, name, content, created_at: now, updated_at: now };
  await db
    .prepare(
      `INSERT INTO notebook_pages (id, namespace, name, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(page.id, page.namespace, page.name, page.content, page.created_at, page.updated_at)
    .run();
  return page;
}

// 按页名新建或整页替换。
export async function writeNotebookPage(
  db: D1Database,
  input: { namespace: string; name: string; content: string }
): Promise<{ page: NotebookPageRow; created: boolean }> {
  const name = normalizeNotebookName(input.name);
  checkContent(input.content);
  const existing = await getNotebookPage(db, { namespace: input.namespace, name });
  if (!existing) {
    try {
      return { page: await insertPage(db, input.namespace, name, input.content), created: true };
    } catch (error) {
      // 刚被另一边建好了：照常整页替换它。
      if (!isNameClash(error)) throw error;
      return writeNotebookPage(db, input);
    }
  }

  const updatedAt = nowIso();
  await db
    .prepare("UPDATE notebook_pages SET content = ?, updated_at = ? WHERE namespace = ? AND id = ?")
    .bind(input.content, updatedAt, input.namespace, existing.id)
    .run();
  return { page: { ...existing, content: input.content, updated_at: updatedAt }, created: false };
}

// 接在页尾，另起一行；没有这页就新建。超出上限整次拒绝，不截断。
export async function appendNotebookPage(
  db: D1Database,
  input: { namespace: string; name: string; content: string }
): Promise<{ page: NotebookPageRow; created: boolean }> {
  const name = normalizeNotebookName(input.name);
  const existing = await getNotebookPage(db, { namespace: input.namespace, name });
  if (!existing) {
    checkContent(input.content);
    try {
      return { page: await insertPage(db, input.namespace, name, input.content), created: true };
    } catch (error) {
      // 刚被另一边建好了：接在它后面。
      if (!isNameClash(error)) throw error;
      return appendNotebookPage(db, input);
    }
  }

  const addition = existing.content ? `\n${input.content}` : input.content;
  const size = charCount(existing.content) + charCount(addition);
  const tooLong = () =>
    new NotebookError(
      `Appending would make the page ${size} characters; a page holds at most ${NOTEBOOK_CONTENT_MAX}. Read it and rewrite it shorter with write`
    );
  if (size > NOTEBOOK_CONTENT_MAX) throw tooLong();

  // 在 SQL 里接，两边同时追加也不会互相盖掉。
  const result = await db
    .prepare(
      `UPDATE notebook_pages SET content = content || ?, updated_at = ?
       WHERE namespace = ? AND id = ? AND length(content) + ? <= ?`
    )
    .bind(addition, nowIso(), input.namespace, existing.id, charCount(addition), NOTEBOOK_CONTENT_MAX)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw tooLong();
  const page = await getNotebookPageById(db, { namespace: input.namespace, id: existing.id });
  if (!page) throw new NotebookError(`Page "${name}" was deleted while appending`);
  return { page, created: false };
}

// 面板用：按 id 改名或改正文。
export async function updateNotebookPage(
  db: D1Database,
  input: { namespace: string; id: string; name?: string; content?: string }
): Promise<NotebookPageRow | null> {
  const existing = await getNotebookPageById(db, input);
  if (!existing) return null;

  const name = input.name === undefined ? existing.name : normalizeNotebookName(input.name);
  const content = input.content ?? existing.content;
  checkContent(content);
  if (name !== existing.name && (await getNotebookPage(db, { namespace: input.namespace, name }))) {
    throw new NotebookError(`There is already a page named "${name}"`);
  }

  const updatedAt = nowIso();
  try {
    await db
      .prepare("UPDATE notebook_pages SET name = ?, content = ?, updated_at = ? WHERE namespace = ? AND id = ?")
      .bind(name, content, updatedAt, input.namespace, input.id)
      .run();
  } catch (error) {
    // 查过之后另一页刚改成了这个名字。
    if (isNameClash(error)) throw new NotebookError(`There is already a page named "${name}"`);
    throw error;
  }
  return { ...existing, name, content, updated_at: updatedAt };
}

export async function deleteNotebookPage(db: D1Database, input: { namespace: string; name: string }): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM notebook_pages WHERE namespace = ? AND name = ?")
    .bind(input.namespace, cleanName(input.name))
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteNotebookPageById(db: D1Database, input: { namespace: string; id: string }): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM notebook_pages WHERE namespace = ? AND id = ?")
    .bind(input.namespace, input.id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// 用完了一次清掉这个空间的全部页，返回删了几页。
export async function clearNotebook(db: D1Database, input: { namespace: string }): Promise<number> {
  const result = await db.prepare("DELETE FROM notebook_pages WHERE namespace = ?").bind(input.namespace).run();
  return result.meta.changes ?? 0;
}
