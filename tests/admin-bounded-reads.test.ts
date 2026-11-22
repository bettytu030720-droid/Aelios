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
  countActiveMemoriesByType,
  countActiveMemoriesOfType,
  countActiveMemoriesTotal,
  getRelationsGraph,
  insertMemoryRelation
} from "../src/db/v2";
import { findOutdatedByDecision } from "../src/memory/currentState/store";
import { sqliteFixture } from "./support/sqlite";

(crypto.subtle as unknown as { timingSafeEqual: typeof timingSafeEqual }).timingSafeEqual = timingSafeEqual;

function instrumentD1(base: D1Database) {
  let rowsRead = 0;
  let rowsWritten = 0;

  const wrapPrepared = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind(...values: unknown[]) {
        return wrapPrepared(stmt.bind(...values));
      },
      async first<T = unknown>(colName?: string) {
        const result = await stmt.all<Record<string, unknown>>();
        rowsRead += Number(result.meta?.rows_read ?? 0);
        rowsWritten += Number(result.meta?.rows_written ?? 0);
        const row = result.results?.[0];
        if (!row) return null as T;
        return (colName ? row[colName] : row) as T;
      },
      async all<T = unknown>() {
        const result = await stmt.all<T>();
        rowsRead += Number(result.meta?.rows_read ?? 0);
        rowsWritten += Number(result.meta?.rows_written ?? 0);
        return result;
      },
      async run<T = unknown>() {
        const result = await stmt.run<T>();
        rowsRead += Number(result.meta?.rows_read ?? 0);
        rowsWritten += Number(result.meta?.rows_written ?? 0);
        return result;
      },
      async raw<T = unknown[]>(options?: { columnNames?: boolean }) {
        return stmt.raw<T>(options as never);
      }
    };
    return wrapped as unknown as D1PreparedStatement;
  };

  const db = {
    prepare(sql: string) {
      return wrapPrepared(base.prepare(sql));
    },
    async batch<T = unknown>(stmts: D1PreparedStatement[]) {
      const results = await base.batch<T>(stmts);
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
    },
    stats() {
      return { rowsRead, rowsWritten };
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

test("memory_type_counts triggers stay exact across insert, status/type/namespace updates, and delete", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const ts = "2026-11-22T10:00:00.000Z";

  sqlite.prepare(`INSERT INTO memories (id, namespace, type, content, status, created_at, updated_at)
    VALUES ('m1', 'ns-a', 'fact', 'one', 'active', ?, ?),
           ('m2', 'ns-a', 'fact', 'two', 'active', ?, ?),
           ('m3', 'ns-a', 'note', 'three', 'archived', ?, ?),
           ('m4', 'ns-b', 'preference', 'four', 'active', ?, ?)`).run(ts, ts, ts, ts, ts, ts, ts, ts);

  const plain = (rows: Array<{ type: string; count: number }>) => rows.map((r) => ({ type: r.type, count: r.count }));

  assert.deepEqual(plain(await countActiveMemoriesByType(db, "ns-a")), [{ type: "fact", count: 2 }]);
  assert.equal(await countActiveMemoriesOfType(db, { namespace: "ns-a", type: "fact" }), 2);
  assert.equal(await countActiveMemoriesTotal(db, "ns-a"), 2);
  assert.deepEqual(plain(await countActiveMemoriesByType(db, "ns-b")), [{ type: "preference", count: 1 }]);

  // Archive m1
  sqlite.prepare("UPDATE memories SET status = 'archived' WHERE id = 'm1'").run();
  assert.deepEqual(plain(await countActiveMemoriesByType(db, "ns-a")), [{ type: "fact", count: 1 }]);

  // Restore m3 from archived -> active
  sqlite.prepare("UPDATE memories SET status = 'active' WHERE id = 'm3'").run();
  assert.deepEqual(plain(await countActiveMemoriesByType(db, "ns-a")), [
    { type: "fact", count: 1 },
    { type: "note", count: 1 }
  ]);
  assert.equal(await countActiveMemoriesTotal(db, "ns-a"), 2);

  // Change type of m2 from fact -> event
  sqlite.prepare("UPDATE memories SET type = 'event' WHERE id = 'm2'").run();
  assert.deepEqual(plain(await countActiveMemoriesByType(db, "ns-a")), [
    { type: "event", count: 1 },
    { type: "note", count: 1 }
  ]);

  // Move m2 to ns-b
  sqlite.prepare("UPDATE memories SET namespace = 'ns-b' WHERE id = 'm2'").run();
  assert.deepEqual(plain(await countActiveMemoriesByType(db, "ns-a")), [{ type: "note", count: 1 }]);
  assert.deepEqual(plain(await countActiveMemoriesByType(db, "ns-b")), [
    { type: "event", count: 1 },
    { type: "preference", count: 1 }
  ]);

  // Delete m3
  sqlite.prepare("DELETE FROM memories WHERE id = 'm3'").run();
  assert.deepEqual(plain(await countActiveMemoriesByType(db, "ns-a")), []);
  assert.equal(await countActiveMemoriesTotal(db, "ns-a"), 0);
});

test("getRelationsGraph returns top-limit active nodes, internal edges only, and exact total_nodes", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const ts = "2026-11-22T10:00:00.000Z";
  sqlite.prepare(`INSERT INTO memories (id, namespace, type, content, importance, status, created_at, updated_at)
    VALUES ('m-hi-1', 'ns', 'fact', 'top 1', 0.95, 'active', ?, ?),
           ('m-hi-2', 'ns', 'fact', 'top 2', 0.90, 'active', ?, ?),
           ('m-lo',   'ns', 'fact', 'low',   0.20, 'active', ?, ?),
           ('m-arch', 'ns', 'fact', 'arch',  0.99, 'archived', ?, ?),
           ('m-other','other','fact','other',0.99, 'active', ?, ?)`).run(ts, ts, ts, ts, ts, ts, ts, ts, ts, ts);

  await insertMemoryRelation(db, { srcId: "m-hi-1", dstId: "m-hi-2", relType: "supports" });
  await insertMemoryRelation(db, { srcId: "m-hi-1", dstId: "m-lo", relType: "same_thread" });
  await insertMemoryRelation(db, { srcId: "m-hi-1", dstId: "m-other", relType: "supports" });

  const graph = await getRelationsGraph(db, { namespace: "ns", limit: 2 });
  assert.deepEqual(graph.nodes.map((n) => n.id), ["m-hi-1", "m-hi-2"]);
  assert.deepEqual(graph.edges, [{ src: "m-hi-1", dst: "m-hi-2", rel_type: "supports", weight: 1 }]);
  assert.equal(graph.meta.total_nodes, 3);
  assert.equal(graph.meta.total_edges, 1);
  assert.equal(graph.meta.truncated, true);
});

test("findOutdatedByDecision preserves outdated detection with bounded CROSS JOIN lookup", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  sqlite.prepare(`INSERT INTO memories (id, namespace, type, content, status, source, fact_key, created_at, updated_at)
    VALUES ('m-old', 'ns', 'fact', 'old choice', 'active', 'extract', 'tea', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
           ('m-dec', 'ns', 'decision', 'new choice', 'active', 'scoped_decision', 'tea', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`).run();
  sqlite.prepare(`INSERT INTO memory_lifecycle (memory_id, namespace, fact_key, valid_as_of, seen_count)
    VALUES ('m-dec', 'ns', 'tea', '2026-02-01T00:00:00.000Z', 1)`).run();

  const outdated = await findOutdatedByDecision(db, "ns", ["m-old", "m-dec"]);
  assert.deepEqual(outdated.get("m-old"), {
    status: "outdated",
    by: "m-dec",
    as_of: "2026-02-01T00:00:00.000Z"
  });
  assert.equal(outdated.has("m-dec"), false);
});

test("D1 rows_read stays bounded across /v1/memory_boot, /v1/memory?limit=10, and /api/relations/graph?limit=10 with 10,000 memories", async (t) => {
  const persist = mkdtempSync(join(tmpdir(), "aelios-admin-137-"));
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
  const env = { DB: metered.db, CHATBOX_API_KEY: "owner-key" } as any;
  const ns = "fixture-perf";

  const callEndpoint = async (path: string) => {
    metered.reset();
    const res = await worker.fetch(
      new Request(`https://aelios.test${path}`, {
        method: "GET",
        headers: { authorization: "Bearer owner-key" }
      }),
      env,
      { waitUntil() {} } as any
    );
    assert.equal(res.status, 200, `${path} returned ${res.status}`);
    const body = (await res.json()) as any;
    return { body, ...metered.stats() };
  };

  // Seed small dataset (10 memories)
  await rawDb
    .prepare(
      `WITH RECURSIVE ids(n) AS (
         VALUES(1) UNION ALL SELECT n + 1 FROM ids WHERE n < 10
       )
       INSERT INTO memories(id, namespace, type, content, created_at, updated_at)
       SELECT 'small-memory-' || n, ?1, 'fact', 'Synthetic text',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
       FROM ids`
    )
    .bind(ns)
    .run();

  const smallBoot = await callEndpoint(`/v1/memory_boot?namespace=${ns}`);
  const smallList = await callEndpoint(`/v1/memory?namespace=${ns}&limit=10`);
  const smallGraph = await callEndpoint(`/api/relations/graph?namespace=${ns}&limit=10`);

  assert.deepEqual(smallBoot.body.data.stats.memory_type_counts, [{ type: "fact", count: 10 }]);
  assert.equal(smallList.body.data.length, 10);
  assert.equal(smallGraph.body.nodes.length, 10);
  assert.equal(smallGraph.body.meta.total_nodes, 10);

  // Add 10,000 synthetic memories in the same namespace (exact Issue #137 reproducer)
  await rawDb
    .prepare(
      `WITH RECURSIVE ids(n) AS (
         VALUES(1) UNION ALL SELECT n + 1 FROM ids WHERE n < 10000
       )
       INSERT INTO memories(id, namespace, type, content, created_at, updated_at)
       SELECT 'perf-memory-' || n, ?1, 'fact', 'Synthetic text',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
       FROM ids`
    )
    .bind(ns)
    .run();

  const bigBoot = await callEndpoint(`/v1/memory_boot?namespace=${ns}`);
  const bigList = await callEndpoint(`/v1/memory?namespace=${ns}&limit=10`);
  const bigGraph = await callEndpoint(`/api/relations/graph?namespace=${ns}&limit=10`);

  // Exact results preserved
  assert.deepEqual(bigBoot.body.data.stats.memory_type_counts, [{ type: "fact", count: 10010 }]);
  assert.equal(bigList.body.data.length, 10);
  assert.equal(bigList.body.paging.has_more, true);
  assert.equal(bigGraph.body.nodes.length, 10);
  assert.equal(bigGraph.body.meta.total_nodes, 10010);
  assert.equal(bigGraph.body.meta.truncated, true);

  // D1 rows_read must NOT scale with the 10,000-row library size (was 20k / 30k / 40k!)
  assert.ok(
    bigBoot.rowsRead < 50 && bigBoot.rowsRead <= smallBoot.rowsRead + 10,
    `memory_boot rows_read grew: small=${smallBoot.rowsRead}, big=${bigBoot.rowsRead}`
  );
  assert.ok(
    bigList.rowsRead < 80 && bigList.rowsRead <= smallList.rowsRead + 15,
    `/v1/memory?limit=10 rows_read grew: small=${smallList.rowsRead}, big=${bigList.rowsRead}`
  );
  assert.ok(
    bigGraph.rowsRead < 80 && bigGraph.rowsRead <= smallGraph.rowsRead + 15,
    `/api/relations/graph?limit=10 rows_read grew: small=${smallGraph.rowsRead}, big=${bigGraph.rowsRead}`
  );
});
