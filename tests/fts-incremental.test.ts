import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getPlatformProxy } from "wrangler";
import worker from "../src/index";
import {
  backfillFts,
  deleteFtsRow,
  insertMemoryFts,
  insertMessageFts,
  type reconcileFts,
  upsertMemoryFts
} from "../src/memory/fts";
import { sqliteFixture } from "./support/sqlite";

(crypto.subtle as unknown as { timingSafeEqual: typeof timingSafeEqual }).timingSafeEqual = timingSafeEqual;

function instrumentD1(base: D1Database) {
  let rowsRead = 0;
  let rowsWritten = 0;
  const statements: string[] = [];

  // batch() must hand the real statements to D1; remember what each wrapper stands for.
  const unwrap = new WeakMap<object, { stmt: D1PreparedStatement; sql: string }>();
  const wrapPrepared = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = {
      bind(...values: unknown[]) {
        return wrapPrepared(stmt.bind(...values), sql);
      },
      async first<T = unknown>(colName?: string) {
        statements.push(sql);
        // Use all() to capture D1 meta.rows_read accurately, then return first row / column.
        const result = await stmt.all<Record<string, unknown>>();
        rowsRead += Number(result.meta?.rows_read ?? 0);
        rowsWritten += Number(result.meta?.rows_written ?? 0);
        const row = result.results?.[0];
        if (!row) return null as T;
        return (colName ? row[colName] : row) as T;
      },
      async all<T = unknown>() {
        statements.push(sql);
        const result = await stmt.all<T>();
        rowsRead += Number(result.meta?.rows_read ?? 0);
        rowsWritten += Number(result.meta?.rows_written ?? 0);
        return result;
      },
      async run<T = unknown>() {
        statements.push(sql);
        const result = await stmt.run<T>();
        rowsRead += Number(result.meta?.rows_read ?? 0);
        rowsWritten += Number(result.meta?.rows_written ?? 0);
        return result;
      },
      async raw<T = unknown[]>(options?: { columnNames?: boolean }) {
        statements.push(sql);
        return stmt.raw<T>(options as never);
      }
    };
    unwrap.set(wrapped, { stmt, sql });
    return wrapped as unknown as D1PreparedStatement;
  };

  const db = {
    prepare(sql: string) {
      return wrapPrepared(base.prepare(sql), sql);
    },
    async batch<T = unknown>(stmts: D1PreparedStatement[]) {
      const inner = stmts.map((stmt) => {
        const entry = unwrap.get(stmt);
        if (entry) statements.push(entry.sql);
        return entry?.stmt ?? stmt;
      });
      const results = await base.batch<T>(inner);
      for (const r of results) {
        rowsRead += Number(r.meta?.rows_read ?? 0);
        rowsWritten += Number(r.meta?.rows_written ?? 0);
      }
      return results;
    },
    exec: base.exec.bind(base),
    dump: base.dump?.bind(base),
    withSession: base.withSession?.bind(base)
  } as unknown as D1Database;

  return {
    db,
    reset() {
      rowsRead = 0;
      rowsWritten = 0;
      statements.length = 0;
    },
    stats() {
      return { rowsRead, rowsWritten, statements: [...statements] };
    }
  };
}

function applyLocalD1Migrations(persistPath: string): void {
  const database = readFileSync("wrangler.toml", "utf8").match(/^database_name\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(database, "wrangler.toml must declare database_name");
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "migrations", "apply", database, "--local", "--persist-to", persistPath],
    {
      encoding: "utf8",
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }
    }
  );
  assert.equal(result.status, 0, `d1 migrations apply failed:\n${result.stdout}\n${result.stderr}`);
}

test("fts_entry_map enables rowid point delete/update and manual paginated reconciliation", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const now = "2026-11-22T10:00:00.000Z";
  sqlite.prepare("INSERT INTO conversations (id, namespace, created_at, updated_at) VALUES ('c1', 'ns', ?, ?)").run(now, now);

  // 1) Normal writes populate fts_entry_map and allow point updates/deletes without scanning message_id/memory_id.
  sqlite.prepare(`INSERT INTO messages (id, conversation_id, namespace, role, content, source, stream, created_at, seq)
    VALUES ('m-live', 'c1', 'ns', 'user', '今晚去海边散步', 'test', 0, ?, 0)`).run(now);
  assert.equal(await insertMessageFts(db, { namespace: "ns", messageId: "m-live", content: "今晚去海边散步" }), true);

  sqlite.prepare(`INSERT INTO memories (id, namespace, type, content, status, created_at, updated_at)
    VALUES ('mem-live', 'ns', 'fact', '喜欢喝桂花乌龙', 'active', ?, ?)`).run(now, now);
  assert.equal(await insertMemoryFts(db, { namespace: "ns", memoryId: "mem-live", content: "喜欢喝桂花乌龙" }), true);

  const mapBefore = sqlite.prepare("SELECT kind, entity_id, fts_rowid FROM fts_entry_map ORDER BY kind, entity_id").all() as Array<{
    kind: string;
    entity_id: string;
    fts_rowid: number;
  }>;
  assert.equal(mapBefore.length, 2);

  // Spy SQL during upsert and delete: must use WHERE rowid = ?, never WHERE memory_id = ? / message_id = ?.
  const seenSql: string[] = [];
  const spiedDb = {
    ...db,
    prepare(sql: string) {
      seenSql.push(sql);
      return db.prepare(sql);
    }
  } as unknown as D1Database;

  assert.equal(await upsertMemoryFts(spiedDb, { namespace: "ns", memoryId: "mem-live", content: "改喝碧螺春了" }), true);
  await deleteFtsRow(spiedDb, "message_fts", "message_id", "m-live");
  assert.equal(seenSql.some((sql) => /DELETE FROM (message|memory)_fts WHERE (message|memory)_id = \?/.test(sql)), false);
  assert.equal(seenSql.some((sql) => /DELETE FROM memory_fts WHERE rowid = \?/.test(sql)), true);
  assert.equal(seenSql.some((sql) => /DELETE FROM message_fts WHERE rowid = \?/.test(sql)), true);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM message_fts WHERE message_id = 'm-live'").get() as { n: number }).n, 0);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM memory_fts WHERE memory_id = 'mem-live'").get() as { n: number }).n, 1);

  // 2) Legacy FTS rows (orphans, duplicates, unmapped valid rows) + missing main-table rows
  //    can be repaired page by page via POST /v1/fts-reconcile.
  sqlite.prepare(`INSERT INTO messages (id, conversation_id, namespace, role, content, source, stream, created_at, seq)
    VALUES ('m-legacy', 'c1', 'ns', 'user', '旧消息已建索引', 'test', 0, '2026-11-22T10:01:00.000Z', 0),
           ('m-missing', 'c1', 'ns', 'assistant', '漏掉没建索引的回复', 'test', 0, '2026-11-22T10:02:00.000Z', 1),
           ('m-empty', 'c1', 'ns', 'user', '...', 'test', 0, '2026-11-22T10:03:00.000Z', 0)`).run();
  // Insert legacy duplicate + orphan directly into message_fts (bypassing fts_entry_map)
  sqlite.prepare("INSERT INTO message_fts (fts_body, namespace, message_id) VALUES ('旧消 息已', 'ns', 'm-legacy')").run();
  sqlite.prepare("INSERT INTO message_fts (fts_body, namespace, message_id) VALUES ('旧消 息已 重复', 'ns', 'm-legacy')").run();
  sqlite.prepare("INSERT INTO message_fts (fts_body, namespace, message_id) VALUES ('孤儿 残留', 'ns', 'm-orphan')").run();

  const env = { DB: db, CHATBOX_API_KEY: "owner-key" } as any;
  const postReconcile = async (body: Record<string, unknown>) => {
    const res = await worker.fetch(
      new Request("https://aelios.test/v1/fts-reconcile", {
        method: "POST",
        headers: { authorization: "Bearer owner-key", "content-type": "application/json" },
        body: JSON.stringify(body)
      }),
      env,
      { waitUntil() {} } as any
    );
    assert.equal(res.status, 200);
    return (await res.json()) as { ok: boolean; data: Awaited<ReturnType<typeof reconcileFts>> };
  };

  // Dry run reports without mutating
  const dry = await postReconcile({ mode: "sync_map", kind: "message", namespace: "*", limit: 2, dry_run: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.data.scanned, 2);
  assert.equal(dry.data.done, false);
  assert.ok(dry.data.next_cursor);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM message_fts").get() as { n: number }).n, 3);

  // Paginated apply across all legacy FTS rows (limit 2 per page)
  let cursor: string | null = null;
  let totalOrphans = 0;
  let totalDuplicates = 0;
  let totalMapped = 0;
  for (let guard = 0; guard < 5; guard += 1) {
    const page = await postReconcile({ mode: "sync_map", kind: "message", namespace: "*", cursor, limit: 2, dry_run: false });
    totalOrphans += page.data.orphans_purged;
    totalDuplicates += page.data.duplicates_purged;
    totalMapped += page.data.mapped;
    cursor = page.data.next_cursor;
    if (page.data.done) break;
  }
  assert.equal(totalOrphans, 1);
  assert.equal(totalDuplicates, 1);
  assert.equal(totalMapped, 1);
  assert.deepEqual(
    (sqlite.prepare("SELECT message_id FROM message_fts ORDER BY message_id").all() as Array<{ message_id: string }>).map(
      (r) => r.message_id
    ),
    ["m-legacy"]
  );

  // Paginated backfill_missing indexes m-missing and skips m-legacy & empty-body m-empty
  const missing = await postReconcile({ mode: "backfill_missing", kind: "message", namespace: "ns", limit: 10, dry_run: false });
  assert.equal(missing.data.done, true);
  assert.equal(missing.data.indexed, 2); // m-live (deleted earlier) + m-missing
  assert.equal(missing.data.failed, 0);
});

test("D1 rows_read stays bounded on no-change and LIMIT 1 maintenance as history scales to 10,000 rows", async (t) => {
  const persist = mkdtempSync(join(tmpdir(), "aelios-fts-136-"));
  t.after(() => rmSync(persist, { recursive: true, force: true }));
  applyLocalD1Migrations(persist);

  const proxy = await getPlatformProxy({
    persist: { path: join(persist, "v3") },
    configPath: "wrangler.toml",
    remoteBindings: false
  });
  t.after(() => proxy.dispose());

  const rawDb = proxy.env.DB as D1Database;
  const metered = instrumentD1(rawDb);
  const ns = "fts-perf";

  // Seed 10,000 synthetic messages + matching FTS rows + map rows (steady-state large library)
  await rawDb
    .prepare("INSERT INTO conversations (id, namespace, created_at, updated_at) VALUES ('conv-perf', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
    .bind(ns)
    .run();

  const TOTAL = 10_000;
  await rawDb
    .prepare(
      `WITH RECURSIVE ids(n) AS (
         VALUES(1) UNION ALL SELECT n + 1 FROM ids WHERE n < ?1
       )
       INSERT INTO messages (id, conversation_id, namespace, role, content, source, stream, created_at, seq)
       SELECT
         printf('perf-msg-%05d', n),
         'conv-perf',
         ?2,
         'user',
         'synthetic utterance ' || n,
         'test',
         0,
         printf('2026-01-01T%02d:%02d:%02d.000Z', (n / 3600) % 24, (n / 60) % 60, n % 60),
         0
       FROM ids`
    )
    .bind(TOTAL, ns)
    .run();

  await rawDb
    .prepare(
      `WITH RECURSIVE ids(n) AS (
         VALUES(1) UNION ALL SELECT n + 1 FROM ids WHERE n < ?1
       )
       INSERT INTO message_fts (rowid, fts_body, namespace, message_id)
       SELECT n, 'synthetic utterance ' || n, ?2, printf('perf-msg-%05d', n)
       FROM ids`
    )
    .bind(TOTAL, ns)
    .run();

  // Case A: Legacy DB BEFORE fts_entry_map is synced — LIMIT 1 must still read O(1), never 10,000 rows!
  metered.reset();
  const legacyStep = await backfillFts(metered.db, { namespace: ns, limit: 1 });
  const legacyStats = metered.stats();
  assert.equal(legacyStep.failed, 0);
  assert.ok(
    legacyStats.rowsRead < 50,
    `expected LIMIT 1 legacy sync to stay bounded (< 50 rows_read on ${TOTAL} rows), got ${legacyStats.rowsRead}`
  );

  // Now simulate completed map sync & caught-up cursor (steady-state nightly run)
  await rawDb
    .prepare(
      `WITH RECURSIVE ids(n) AS (
         VALUES(1) UNION ALL SELECT n + 1 FROM ids WHERE n < ?1
       )
       INSERT OR REPLACE INTO fts_entry_map (kind, entity_id, namespace, fts_rowid, updated_at)
       SELECT 'message', printf('perf-msg-%05d', n), ?2, n, '2026-01-01T23:59:59.000Z'
       FROM ids`
    )
    .bind(TOTAL, ns)
    .run();

  const lastRow = await rawDb
    .prepare(
      `SELECT id, created_at, seq FROM messages
       WHERE namespace = ? AND role IN ('user', 'assistant')
       ORDER BY created_at DESC, seq DESC, id DESC
       LIMIT 1`
    )
    .bind(ns)
    .first<{ id: string; created_at: string; seq: number }>();
  assert.ok(lastRow);

  await rawDb
    .prepare(
      `INSERT OR REPLACE INTO fts_maintenance_state
         (scope, kind, cursor_ts, cursor_seq, cursor_id, fts_sync_rowid, fts_synced, updated_at)
       VALUES
         ('__map__', 'message', '', 0, '', ?1, 1, '2026-01-02T00:00:00.000Z'),
         ('__map__', 'memory',  '', 0, '', 0,  1, '2026-01-02T00:00:00.000Z'),
         (?2, 'message', ?3, ?4, ?5, 0, 0, '2026-01-02T00:00:00.000Z'),
         (?2, 'memory',  '', 0, '',  0, 0, '2026-01-02T00:00:00.000Z')`
    )
    .bind(TOTAL, ns, lastRow.created_at, lastRow.seq, lastRow.id)
    .run();

  // Case B: No-change nightly maintenance on 10,000 rows
  metered.reset();
  const noop = await backfillFts(metered.db, { namespace: ns, limit: 400 });
  const noopStats = metered.stats();
  assert.equal(noop.messagesIndexed, 0);
  assert.equal(noop.memoriesIndexed, 0);
  assert.equal(noop.messageOrphansPurged, 0);
  assert.equal(noop.memoryOrphansPurged, 0);
  assert.ok(
    noopStats.rowsRead < 30,
    `expected no-change maintenance on ${TOTAL} rows to read < 30 rows, got ${noopStats.rowsRead}`
  );

  // Case C: 5 new unindexed messages arrive; LIMIT 1 maintenance indexes 1 without scanning history
  for (let i = 1; i <= 5; i += 1) {
    await rawDb
      .prepare(
        `INSERT INTO messages (id, conversation_id, namespace, role, content, source, stream, created_at, seq)
         VALUES (?, 'conv-perf', ?, 'user', ?, 'test', 0, ?, 0)`
      )
      .bind(`perf-new-${i}`, ns, `new arrival message ${i}`, `2026-01-02T00:00:0${i}.000Z`)
      .run();
  }

  metered.reset();
  const one = await backfillFts(metered.db, { namespace: ns, limit: 1 });
  const oneStats = metered.stats();
  assert.equal(one.messagesIndexed, 1);
  assert.equal(one.failed, 0);
  assert.ok(
    oneStats.rowsRead < 50,
    `expected LIMIT 1 maintenance on ${TOTAL} rows to read < 50 rows, got ${oneStats.rowsRead}`
  );

  // Case D: Point delete of 1 indexed message out of 10,000 reads O(1) rows
  metered.reset();
  await deleteFtsRow(metered.db, "message_fts", "message_id", "perf-msg-05000");
  const delStats = metered.stats();
  assert.ok(
    delStats.rowsRead < 30,
    `expected point delete on ${TOTAL} FTS rows to read < 30 rows, got ${delStats.rowsRead}`
  );
  const remaining = await rawDb
    .prepare("SELECT COUNT(*) AS n FROM fts_entry_map WHERE kind = 'message' AND entity_id = 'perf-msg-05000'")
    .first<{ n: number }>();
  assert.equal(remaining?.n, 0);
});

test("an FTS row and its map entry commit together, so no row is left unmapped", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  sqlite.exec(`CREATE TRIGGER fail_map_write BEFORE INSERT ON fts_entry_map WHEN NEW.entity_id = 'boom'
    BEGIN SELECT RAISE(ABORT, 'map write failed'); END`);
  const ftsRows = (id: string) => sqlite.prepare("SELECT rowid FROM message_fts WHERE message_id = ?").all(id);
  const mapped = (id: string) => sqlite.prepare("SELECT fts_rowid FROM fts_entry_map WHERE kind = 'message' AND entity_id = ?").get(id);

  assert.equal(await insertMessageFts(db, { namespace: "ns", messageId: "ok-1", content: "晚安 早点睡" }), true);
  assert.equal(await insertMessageFts(db, { namespace: "ns", messageId: "ok-2", content: "明天见 晚安" }), true);
  for (const id of ["ok-1", "ok-2"]) assert.equal(Number(mapped(id)?.fts_rowid), Number(ftsRows(id)[0]?.rowid), id);

  // A failed map write rolls the FTS row back with it instead of leaving a row no delete can find.
  assert.equal(await insertMessageFts(db, { namespace: "ns", messageId: "boom", content: "撤回这句 也删得掉" }), false);
  assert.deepEqual(ftsRows("boom"), []);
  assert.equal(mapped("boom"), undefined);

  await deleteFtsRow(db, "message_fts", "message_id", "ok-1");
  assert.deepEqual(ftsRows("ok-1"), []);
  assert.equal(ftsRows("ok-2").length, 1, "the point delete removed only its own row");
});
