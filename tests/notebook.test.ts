import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { runInNewContext } from "node:vm";
import worker from "../src/index";
import { invalidateSettingsCache } from "../src/gateway/config";
import { ADMIN_HTML } from "../src/api/admin/ui";
import { runMemoryRetention } from "../src/memory/retention";

// The notebook: named pages both assistants read and rewrite, kept apart from memories,
// over MCP (by name) and REST (by id, for the admin panel).
(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);
let sqlite: DatabaseSync;
let env: any;

beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((f: string) => f.endsWith(".sql")).sort()) {
    try { sqlite.exec(readFileSync(`migrations/${file}`, "utf8")); }
    catch (error) {
      if (!String(error).includes("fts5")) throw error;
    }
  }
  const db = { prepare(sql: string) {
    const statement = sqlite.prepare(sql); let args: any[] = [];
    const api = { bind(...values: any[]) { args = values; return api; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { const r = statement.run(...args); return { meta: { changes: r.changes } }; }
    }; return api;
  }, async batch(statements: any[]) {
    const results = []; for (const statement of statements) results.push(await statement.run()); return results;
  } };
  invalidateSettingsCache();
  env = { DB: db, CHATBOX_API_KEY: "owner-key", MEMORY_MCP_API_KEY: "mcp-key", GUIDE_DOG_API_KEY: "dog-key",
    AI: { async run() { return { data: [[0.1, 0.2, 0.3]] }; } },
    VECTORIZE: { async upsert() { return {}; }, async deleteByIds() { return {}; }, async query() { return { matches: [] }; } } };
  globalThis.fetch = async (url: any) => { throw new Error(`unexpected upstream call: ${url}`); };
});

async function rpc(method: string, params: any = {}, key = "owner-key") {
  const response = await worker.fetch(new Request("https://aelios.test/mcp", { method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env, { waitUntil() {} } as any);
  return (await response.json() as any).result;
}
const nb = (args: any, key?: string) => rpc("tools/call", { name: "notebook", arguments: args }, key);
const data = async (args: any, key?: string) => (await nb(args, key)).structuredContent.data;
const errorText = async (args: any, key?: string) => {
  const result = await nb(args, key);
  assert.equal(result.isError, true, JSON.stringify(result));
  return result.content[0].text as string;
};
const pages = (namespace = "default") =>
  sqlite.prepare("SELECT * FROM notebook_pages WHERE namespace = ? ORDER BY name").all(namespace) as any[];

async function rest(path: string, init: { method?: string; body?: any; key?: string } = {}) {
  const response = await worker.fetch(new Request(`https://aelios.test${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${init.key ?? "owner-key"}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined
  }), env, { waitUntil() {} } as any);
  return { status: response.status, body: await response.json() as any };
}

test("the notebook tool is listed with one action switch", async () => {
  const tool = (await rpc("tools/list")).tools.find((t: any) => t.name === "notebook");
  assert.deepEqual(tool.inputSchema.properties.action.enum, ["list", "read", "write", "append", "delete"]);
  assert.deepEqual(tool.inputSchema.required, ["action"]);
  assert.match(tool.description, /never recalled automatically/);
});

test("write, read, rewrite, append, list and delete a page by name", async () => {
  const created = await data({ action: "write", name: "  经济师  进度 ", content: "第 1-3 章做完。" });
  assert.deepEqual(created, { name: "经济师 进度", size: 10, created: true });
  const [first] = pages();

  const read = await data({ action: "read", name: "经济师 进度" });
  assert.equal(read.content, "第 1-3 章做完。");

  // A rewrite keeps the page (same id), only the text changes.
  const rewritten = await data({ action: "write", name: "经济师 进度", content: "第 1-4 章做完。薄弱：税收。" });
  assert.equal(rewritten.created, false);
  assert.equal(pages().length, 1);
  assert.equal(pages()[0].id, first.id);

  await data({ action: "append", name: "经济师 进度", content: "下一步：第 5 章。" });
  assert.equal((await data({ action: "read", name: "经济师 进度" })).content, "第 1-4 章做完。薄弱：税收。\n下一步：第 5 章。");

  // Appending to a page that does not exist starts it.
  assert.equal((await data({ action: "append", name: "错题", content: "第 12 题" })).created, true);
  sqlite.prepare("UPDATE notebook_pages SET updated_at = '2026-10-01T00:00:00.000Z' WHERE name = '经济师 进度'").run();
  sqlite.prepare("UPDATE notebook_pages SET updated_at = '2026-10-02T00:00:00.000Z' WHERE name = '错题'").run();
  const list = await data({ action: "list" });
  assert.deepEqual(list.map((p: any) => p.name), ["错题", "经济师 进度"]);
  assert.deepEqual(Object.keys(list[0]).sort(), ["name", "size", "updated_at"]);

  assert.deepEqual(await data({ action: "delete", name: "错题" }), { name: "错题", deleted: true });
  assert.deepEqual(pages().map((p) => p.name), ["经济师 进度"]);
});

test("a missing page says so and names the pages there are", async () => {
  const empty = (await nb({ action: "read", name: "经济师进度" })).structuredContent;
  assert.equal(empty.data, null);
  assert.match(empty.note, /no page named "经济师进度"\. The notebook is empty/);

  await data({ action: "write", name: "读书清单", content: "《置身事内》" });
  await data({ action: "write", name: "错题", content: "第 12 题" });
  const missing = (await nb({ action: "read", name: "经济师进度" })).structuredContent;
  assert.equal(missing.data, null);
  assert.match(missing.note, /no page named "经济师进度"/);
  assert.match(missing.note, /读书清单/);
  assert.match(missing.note, /错题/);
  assert.match(await errorText({ action: "delete", name: "经济师进度" }), /no page named .*Pages: /);
});

test("names, page size and page count are limited; nothing is truncated", async () => {
  assert.match(await errorText({ action: "write", name: "   ", content: "x" }), /name is required/);
  assert.match(await errorText({ action: "write", name: "页".repeat(61), content: "x" }), /too long/);
  assert.equal((await data({ action: "write", name: "页".repeat(60), content: "x" })).created, true);
  assert.match(await errorText({ action: "write", name: "空" }), /content is required/);
  assert.match(await errorText({ action: "read" }), /name is required/);
  assert.match(await errorText({ action: "rename", name: "x" }), /action must be one of/);

  assert.match(await errorText({ action: "write", name: "长", content: "字".repeat(20001) }), /at most 20000/);
  assert.equal((await data({ action: "write", name: "长", content: "字".repeat(19990) })).size, 19990);
  // 19990 + newline + 10 = 20001: refused whole, the page stays as it was.
  assert.match(await errorText({ action: "append", name: "长", content: "加".repeat(10) }), /20001 characters.*at most 20000/);
  assert.equal(pages().find((p) => p.name === "长").content, "字".repeat(19990));
  assert.equal((await data({ action: "append", name: "长", content: "加".repeat(9) })).size, 20000);

  for (let i = pages().length; i < 50; i += 1) await data({ action: "write", name: `第${i}页`, content: "x" });
  assert.equal(pages().length, 50);
  assert.match(await errorText({ action: "write", name: "第五十一页", content: "x" }), /full \(50 pages\)/);
  assert.match(await errorText({ action: "append", name: "第五十一页", content: "x" }), /full/);
  // A full notebook still takes rewrites of pages it has.
  assert.equal((await data({ action: "write", name: "第3页", content: "改过" })).created, false);
});

test("pages stay in their own namespace; the MCP key is pinned to its own", async () => {
  await data({ action: "write", name: "进度", content: "望舒的", namespace: "wangshu" });
  await data({ action: "write", name: "进度", content: "旦九的" });
  assert.equal((await data({ action: "read", name: "进度", namespace: "wangshu" })).content, "望舒的");
  assert.equal((await data({ action: "read", name: "进度" })).content, "旦九的");

  await data({ action: "write", name: "只在默认", content: "x", namespace: "wangshu" }, "mcp-key");
  assert.deepEqual(pages("wangshu").map((p) => p.name), ["进度"]);
  assert.deepEqual(pages("default").map((p) => p.name), ["只在默认", "进度"]);
  await data({ action: "delete", name: "进度" });
  assert.equal(pages("wangshu").length, 1);
});

test("reading needs memory:read and changing needs memory:write", async () => {
  await data({ action: "write", name: "进度", content: "x" });
  assert.equal(await errorText({ action: "list" }, "dog-key"), "Missing memory:read scope");
  assert.equal(await errorText({ action: "read", name: "进度" }, "dog-key"), "Missing memory:read scope");
  for (const action of ["write", "append", "delete"]) {
    assert.equal(await errorText({ action, name: "进度", content: "y" }, "dog-key"), "Missing memory:write scope");
  }
  assert.equal(pages()[0].content, "x");
});

test("wake_up names the pages, at most twenty, and says nothing when there are none", async () => {
  const before = (await rpc("tools/call", { name: "wake_up", arguments: {} })).structuredContent.data;
  assert.equal("notebook" in before, false);
  assert.match(before.how_to_use, /notebook/);

  for (let i = 1; i <= 25; i += 1) {
    await data({ action: "write", name: `第${i}章`, content: "x" });
    sqlite.prepare("UPDATE notebook_pages SET updated_at = ? WHERE name = ?").run(`2026-10-01T00:00:${String(i).padStart(2, "0")}.000Z`, `第${i}章`);
  }
  const after = (await rpc("tools/call", { name: "wake_up", arguments: {} })).structuredContent.data;
  assert.match(after.notebook, /^Notebook pages \(open one with notebook\): 第25章, 第24章/);
  assert.match(after.notebook, /第6章 and 5 more\.$/);
  assert.doesNotMatch(after.notebook, /第5章/);
});

test("REST lists, creates, replaces, opens, edits, deletes and clears pages", async () => {
  const created = await rest("/v1/notebook?namespace=wangshu", { method: "POST", body: { name: "经济师进度", content: "第 1 章" } });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal((await rest("/v1/notebook?namespace=wangshu", { method: "POST", body: { name: "经济师进度", content: "第 1-2 章" } })).status, 200);
  assert.equal(pages("wangshu").length, 1);
  assert.equal(pages("default").length, 0);

  const list = await rest("/v1/notebook?namespace=wangshu");
  assert.deepEqual(list.body.data.map((p: any) => [p.id, p.name, p.size]), [[id, "经济师进度", 7]]);
  assert.equal((await rest(`/v1/notebook/${id}?namespace=wangshu`)).body.data.content, "第 1-2 章");
  assert.equal((await rest(`/v1/notebook/${id}`)).status, 404);

  await rest("/v1/notebook?namespace=wangshu", { method: "POST", body: { name: "错题", content: "第 12 题" } });
  const patched = await rest(`/v1/notebook/${id}?namespace=wangshu`, { method: "PATCH", body: { name: "经济师 进度", content: "全部做完" } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.name, "经济师 进度");
  assert.equal(pages("wangshu").find((p) => p.id === id).content, "全部做完");
  const clash = await rest(`/v1/notebook/${id}?namespace=wangshu`, { method: "PATCH", body: { name: "错题" } });
  assert.equal(clash.status, 400);
  assert.match(clash.body.error.message, /already a page named "错题"/);
  assert.equal((await rest("/v1/notebook/nb_missing?namespace=wangshu", { method: "PATCH", body: { content: "x" } })).status, 404);
  assert.equal((await rest("/v1/notebook?namespace=wangshu", { method: "POST", body: { name: "空" } })).status, 400);

  assert.equal((await rest(`/v1/notebook/${id}?namespace=wangshu`, { method: "DELETE" })).status, 200);
  assert.equal((await rest(`/v1/notebook/${id}?namespace=wangshu`, { method: "DELETE" })).status, 404);

  await rest("/v1/notebook", { method: "POST", body: { name: "默认的", content: "x" } });
  assert.equal((await rest("/v1/notebook?namespace=wangshu", { method: "DELETE" })).status, 400);
  const cleared = await rest("/v1/notebook?namespace=wangshu&confirm=all", { method: "DELETE" });
  assert.deepEqual(cleared.body.data, { deleted: 1 });
  assert.equal(pages("wangshu").length, 0);
  assert.deepEqual(pages("default").map((p) => p.name), ["默认的"]);

  assert.equal((await rest("/v1/notebook", { key: "dog-key" })).status, 403);
  assert.equal((await rest("/v1/notebook?confirm=all", { method: "DELETE", key: "dog-key" })).status, 403);
  assert.equal((await rest("/v1/notebook", { key: "wrong" })).status, 401);
});

test("retention leaves old pages alone", async () => {
  sqlite.prepare(`INSERT INTO notebook_pages (id, namespace, name, content, created_at, updated_at)
    VALUES ('nb_old', 'default', '旧页', '一年前写的', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`).run();
  assert.equal((await runMemoryRetention(env, "default")).ran, true);
  assert.equal(pages()[0].content, "一年前写的");
});

test("the admin panel opens, saves, deletes and clears pages through the REST routes", async () => {
  const script = (ADMIN_HTML.match(/<script>\s*(function memoryAdmin\(\)[\s\S]*?)<\/script>/) as RegExpMatchArray)[1];
  const confirms: string[] = [];
  const app = runInNewContext(`${script}\nmemoryAdmin()`, {
    localStorage: { getItem: () => null, setItem() {} },
    location: { origin: "https://aelios.test" },
    document: { documentElement: { dataset: {} } },
    window: { setTimeout() {}, confirm: (text: string) => { confirms.push(text); return true; } }
  });
  assert.equal(JSON.stringify(app.moreNav.map((item: any) => item.label).slice(0, 3)), '["珍贵","黑话","小本本"]');
  app.icons = () => {};
  app.apiKey = "owner";
  const calls: Array<[string, string]> = [];
  const page = { id: "nb_1", name: "经济师进度", content: "第 1 章", updated_at: "2026-10-01T00:00:00.000Z" };
  app.request = async (path: string, options: any = {}) => {
    calls.push([options.method || "GET", path]);
    if (path.startsWith("/v1/notebook?namespace")) return { data: [{ id: "nb_1", name: "经济师进度", size: 5, updated_at: page.updated_at }] };
    return { data: page };
  };

  await app.loadNotebook();
  await app.openNotebookPage(app.notebookPages[0]);
  assert.equal(app.notebookDraft.content, "第 1 章");
  await app.saveNotebookPage();
  app.newNotebookPage();
  app.notebookDraft.name = " 经济师进度 ";
  app.notebookDraft.content = "新写的";
  await app.saveNotebookPage();
  assert.match(confirms[0], /已经有一页叫「经济师进度」/);
  await app.openNotebookPage(app.notebookPages[0]);
  await app.deleteNotebookPage();
  await app.loadNotebook();
  await app.clearNotebook();
  assert.match(confirms[confirms.length - 1], /确认清空小本本/);

  const writes = calls.filter(([method]) => method !== "GET");
  assert.deepEqual(writes, [
    ["PATCH", "/v1/notebook/nb_1?namespace=default"],
    ["POST", "/v1/notebook?namespace=default"],
    ["DELETE", "/v1/notebook/nb_1?namespace=default"],
    ["DELETE", "/v1/notebook?confirm=all&namespace=default"]
  ]);
  assert.match(ADMIN_HTML, /x-text="item\.name"/);
  assert.match(ADMIN_HTML, /x-model="notebookDraft\.content"/);
});

test("a page another call creates or renames in between is replaced, appended to or refused, never a raw error", async () => {
  const { writeNotebookPage, appendNotebookPage, updateNotebookPage, NotebookError } = await import("../src/db/v2");
  await data({ action: "write", name: "进度", content: "旧" });
  await data({ action: "write", name: "错题", content: "第 1 道" });
  // The look by name misses once, as if the other call's insert landed right after it.
  let misses = 0;
  const racy = { ...env.DB, prepare(sql: string) {
    if (misses > 0 && /^SELECT \* FROM notebook_pages WHERE namespace = \? AND name = \?/.test(sql)) {
      misses--;
      const miss = { bind() { return miss; }, async first() { return null; } };
      return miss;
    }
    return env.DB.prepare(sql);
  } };

  misses = 1;
  const written = await writeNotebookPage(racy as any, { namespace: "default", name: "进度", content: "新" });
  assert.equal(written.created, false);
  misses = 1;
  await appendNotebookPage(racy as any, { namespace: "default", name: "进度", content: "再加一行" });
  assert.equal(pages().find((page) => page.name === "进度").content, "新\n再加一行");
  assert.equal(pages().length, 2);

  misses = 1;
  const wrong = pages().find((page) => page.name === "错题");
  await assert.rejects(
    updateNotebookPage(racy as any, { namespace: "default", id: wrong.id, name: "进度" }),
    (error: unknown) => error instanceof NotebookError && /already a page named "进度"/.test((error as Error).message)
  );
});
