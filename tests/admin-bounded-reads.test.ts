import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getPlatformProxy } from "wrangler";
import worker from "../src/index";
import { countMessagesInRange } from "../src/api/memories/shared";
import { encodeMemoryCursor, listMemoriesPage } from "../src/db/memories";
import {
  countActiveMemoriesByType,
  countActiveMemoriesOfType,
  countActiveMemoriesTotal,
  countMemoryCandidates,
  getRelationsGraph,
  IMPORT_CANDIDATE_SOURCES,
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

test("getRelationsGraph preserves cross-batch internal edges when selected nodes exceed 45 (#140)", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const ts = "2026-11-22T10:00:00.000Z";
  const insertMem = sqlite.prepare(
    `INSERT INTO memories (id, namespace, type, content, importance, status, created_at, updated_at)
     VALUES (?, 'ns-batch', 'fact', 'node', ?, 'active', ?, ?)`
  );
  for (let index = 1; index <= 60; index++) {
    insertMem.run(`m-${String(index).padStart(3, "0")}`, 1 - index * 0.001, ts, ts);
  }
  insertMem.run("m-outside", 0.01, ts, ts);

  // Cross-batch internal edges (node 1 <-> node 60) plus out-of-page edges
  await insertMemoryRelation(db, { srcId: "m-001", dstId: "m-060", relType: "supports" });
  await insertMemoryRelation(db, { srcId: "m-060", dstId: "m-001", relType: "derived_from" });
  await insertMemoryRelation(db, { srcId: "m-001", dstId: "m-outside", relType: "supports" });

  const graph = await getRelationsGraph(db, { namespace: "ns-batch", limit: 60 });
  assert.equal(graph.nodes.length, 60);
  assert.equal(graph.meta.total_nodes, 61);
  assert.equal(graph.meta.truncated, true);
  assert.equal(graph.edges.length, 2);
  const edgeKeys = graph.edges.map((edge) => `${edge.src}->${edge.dst}:${edge.rel_type}`).sort();
  assert.deepEqual(edgeKeys, ["m-001->m-060:supports", "m-060->m-001:derived_from"]);
});

test("memory_candidate_counts and message_hour_counts triggers stay exact across mutations (#141)", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const ts = "2026-11-23T08:15:00.000Z";

  sqlite
    .prepare(
      `INSERT INTO memory_candidates (id, namespace, type, content, source, status, created_at, updated_at)
       VALUES ('c1', 'ns-c', 'fact', 'daily 1', 'extract', 'pending', ?, ?),
              ('c2', 'ns-c', 'fact', 'import 1', 'import_entries', 'pending', ?, ?),
              ('c3', 'ns-c', 'fact', 'import 2', 'import_chat', 'pending', ?, ?),
              ('c4', 'ns-c', 'fact', 'approved', 'extract', 'approved', ?, ?)`
    )
    .run(ts, ts, ts, ts, ts, ts, ts, ts);

  assert.equal(await countMemoryCandidates(db, { namespace: "ns-c", status: "pending", excludeSources: IMPORT_CANDIDATE_SOURCES }), 1);
  assert.equal(await countMemoryCandidates(db, { namespace: "ns-c", status: "pending", onlySources: IMPORT_CANDIDATE_SOURCES }), 2);

  // Approve c2, change c1 source to import_entries, move c3 to another namespace, delete c1
  sqlite.prepare("UPDATE memory_candidates SET status = 'approved' WHERE id = 'c2'").run();
  assert.equal(await countMemoryCandidates(db, { namespace: "ns-c", status: "pending", onlySources: IMPORT_CANDIDATE_SOURCES }), 1);

  sqlite.prepare("UPDATE memory_candidates SET source = 'import_entries' WHERE id = 'c1'").run();
  assert.equal(await countMemoryCandidates(db, { namespace: "ns-c", status: "pending", excludeSources: IMPORT_CANDIDATE_SOURCES }), 0);
  assert.equal(await countMemoryCandidates(db, { namespace: "ns-c", status: "pending", onlySources: IMPORT_CANDIDATE_SOURCES }), 2);

  sqlite.prepare("UPDATE memory_candidates SET namespace = 'ns-other' WHERE id = 'c3'").run();
  assert.equal(await countMemoryCandidates(db, { namespace: "ns-c", status: "pending", onlySources: IMPORT_CANDIDATE_SOURCES }), 1);
  assert.equal(await countMemoryCandidates(db, { namespace: "ns-other", status: "pending", onlySources: IMPORT_CANDIDATE_SOURCES }), 1);

  sqlite.prepare("DELETE FROM memory_candidates WHERE id = 'c1'").run();
  assert.equal(await countMemoryCandidates(db, { namespace: "ns-c", status: "pending", onlySources: IMPORT_CANDIDATE_SOURCES }), 0);

  // Message hour counts & boundary math
  sqlite
    .prepare(
      `INSERT INTO messages (id, conversation_id, namespace, role, content, created_at)
       VALUES ('msg1', 'conv1', 'ns-m', 'user', 'early', '2026-11-23T08:10:00.000Z'),
              ('msg2', 'conv1', 'ns-m', 'assistant', 'mid', '2026-11-23T08:40:00.000Z'),
              ('msg3', 'conv1', 'ns-m', 'user', 'next hour', '2026-11-23T09:20:00.000Z'),
              ('msg4', 'conv1', 'ns-m', 'user', 'tail', '2026-11-23T09:50:00.000Z'),
              ('msg5', 'conv1', 'ns-m', 'system', 'ignored', '2026-11-23T09:05:00.000Z')`
    )
    .run();

  assert.equal(
    await countMessagesInRange(db, {
      namespace: "ns-m",
      startCreatedAt: "2026-11-23T08:00:00.000Z",
      endCreatedAt: "2026-11-23T10:00:00.000Z"
    }),
    4
  );
  assert.equal(
    await countMessagesInRange(db, {
      namespace: "ns-m",
      startCreatedAt: "2026-11-23T08:30:00.000Z",
      endCreatedAt: "2026-11-23T09:30:00.000Z"
    }),
    2
  );
  assert.equal(
    await countMessagesInRange(db, {
      namespace: "ns-m",
      startCreatedAt: "2026-11-23T08:05:00.000Z",
      endCreatedAt: "2026-11-23T08:30:00.000Z"
    }),
    1
  );

  // Mutate role, timestamp, and delete
  sqlite.prepare("UPDATE messages SET role = 'tool' WHERE id = 'msg2'").run();
  sqlite.prepare("UPDATE messages SET created_at = '2026-11-23T11:00:00.000Z' WHERE id = 'msg3'").run();
  sqlite.prepare("DELETE FROM messages WHERE id = 'msg1'").run();
  assert.equal(
    await countMessagesInRange(db, {
      namespace: "ns-m",
      startCreatedAt: "2026-11-23T08:00:00.000Z",
      endCreatedAt: "2026-11-23T10:00:00.000Z"
    }),
    1
  );
});

test("keyset pagination traverses tied sort keys without duplicates or gaps (#142)", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const ts = "2026-11-23T00:00:00.000Z";
  const insert = sqlite.prepare(
    `INSERT INTO memories (id, namespace, type, content, pinned, importance, status, created_at, updated_at)
     VALUES (?, 'ns-tie', 'fact', 'same score', 0, 0.5, 'active', ?, ?)`
  );
  const expectedIds: string[] = [];
  for (let index = 1; index <= 25; index++) {
    const id = `mem-${String(index).padStart(3, "0")}`;
    insert.run(id, ts, ts);
    expectedIds.push(id);
  }
  expectedIds.sort().reverse();

  const seenIds: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 10; guard++) {
    const page = await listMemoriesPage(db, {
      namespace: "ns-tie",
      status: "active",
      limit: 7,
      cursor
    });
    seenIds.push(...page.records.map((record) => record.id));
    if (!page.hasMore) break;
    assert.ok(page.nextCursor, "hasMore page must provide nextCursor");
    cursor = page.nextCursor;
  }

  assert.deepEqual(seenIds, expectedIds);

  // Legacy numeric offset remains compatible
  const offsetPage = await listMemoriesPage(db, {
    namespace: "ns-tie",
    status: "active",
    limit: 5,
    offset: 10
  });
  assert.deepEqual(
    offsetPage.records.map((record) => record.id),
    expectedIds.slice(10, 15)
  );
});

test("D1 rows_read stays bounded for out-of-page graph edges (#140), boot backlog (#141), and deep cursor pages (#142)", async (t) => {
  const persist = mkdtempSync(join(tmpdir(), "aelios-admin-140-142-"));
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

  const callEndpoint = async (path: string, expectedStatus = 200) => {
    metered.reset();
    const res = await worker.fetch(
      new Request(`https://aelios.test${path}`, {
        method: "GET",
        headers: { authorization: "Bearer owner-key" }
      }),
      env,
      { waitUntil() {} } as any
    );
    assert.equal(res.status, expectedStatus, `${path} returned ${res.status}`);
    const body = (await res.json()) as any;
    return { body, ...metered.stats() };
  };

  // --- #140 & #142: 10,010 active memories ---
  const nsGraph = "perf-graph-list";
  await rawDb
    .prepare(
      `WITH RECURSIVE ids(n) AS (
         VALUES(1) UNION ALL SELECT n + 1 FROM ids WHERE n < 10010
       )
       INSERT INTO memories(id, namespace, type, content, importance, created_at, updated_at)
       SELECT 'm-' || printf('%05d', n), ?1, 'fact', 'Synthetic text',
              CASE WHEN n <= 10 THEN 0.99 ELSE 0.5 END,
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
       FROM ids`
    )
    .bind(nsGraph)
    .run();

  // One internal edge within top 10
  await rawDb
    .prepare(
      `INSERT INTO memory_relations(src_id, dst_id, rel_type, weight, created_by, created_at)
       VALUES ('m-00001', 'm-00002', 'supports', 1.0, 'test', '2026-01-01T00:00:00.000Z')`
    )
    .run();

  const graphBefore = await callEndpoint(`/api/relations/graph?namespace=${nsGraph}&limit=10`);
  assert.equal(graphBefore.body.nodes.length, 10);
  assert.equal(graphBefore.body.edges.length, 1);

  // Add 5,000 outgoing edges from m-00001 to out-of-page nodes (exact #140 reproducer)
  await rawDb
    .prepare(
      `WITH RECURSIVE ids(n) AS (
         VALUES(11) UNION ALL SELECT n + 1 FROM ids WHERE n < 5010
       )
       INSERT INTO memory_relations(src_id, dst_id, rel_type, weight, created_by, created_at)
       SELECT 'm-00001', 'm-' || printf('%05d', n), 'supports', 1.0, 'test', '2026-01-01T00:00:00.000Z'
       FROM ids`
    )
    .run();

  const graphAfter = await callEndpoint(`/api/relations/graph?namespace=${nsGraph}&limit=10`);
  assert.deepEqual(graphAfter.body.nodes, graphBefore.body.nodes);
  assert.deepEqual(graphAfter.body.edges, graphBefore.body.edges);
  assert.ok(
    graphAfter.rowsRead < 200 && graphAfter.rowsRead <= graphBefore.rowsRead + 10,
    `#140 graph rows_read grew with out-of-page edges: before=${graphBefore.rowsRead}, after=${graphAfter.rowsRead}`
  );

  // #142: Deep page via keyset cursor vs offset=9000
  const firstPage = await callEndpoint(`/v1/memory?namespace=${nsGraph}&limit=10`);
  assert.equal(firstPage.body.data.length, 10);
  assert.ok(typeof firstPage.body.paging.cursor === "string" && firstPage.body.paging.cursor.startsWith("k1:"));

  // Item #9000 in DESC order (m-00010..m-00001 are top 10 with importance=0.99, then m-10010 down to m-00011 with importance=0.5)
  const anchorRow = await rawDb
    .prepare(
      `SELECT id, pinned, importance, updated_at
       FROM memories
       WHERE namespace = ? AND status = 'active'
       ORDER BY pinned DESC, importance DESC, updated_at DESC, id DESC
       LIMIT 1 OFFSET 8999`
    )
    .bind(nsGraph)
    .first<{ id: string; pinned: number; importance: number; updated_at: string }>();
  assert.ok(anchorRow, "anchor row at offset 8999 must exist");
  const deepCursor = encodeMemoryCursor(anchorRow);

  const deepCursorPage = await callEndpoint(
    `/v1/memory?namespace=${nsGraph}&limit=10&cursor=${encodeURIComponent(deepCursor)}`
  );
  const deepOffsetPage = await callEndpoint(`/v1/memory?namespace=${nsGraph}&limit=10&offset=9000`);
  assert.deepEqual(
    deepCursorPage.body.data.map((row: any) => row.id),
    deepOffsetPage.body.data.map((row: any) => row.id)
  );
  assert.ok(
    deepCursorPage.rowsRead < 80 && deepCursorPage.rowsRead <= firstPage.rowsRead + 15,
    `#142 deep cursor rows_read grew: first=${firstPage.rowsRead}, deepCursor=${deepCursorPage.rowsRead}`
  );
  await callEndpoint(`/v1/memory?namespace=${nsGraph}&cursor=not-a-valid-cursor`, 400);

  // --- #141a: 10,000 pending import candidates ---
  const nsCandidates = "perf-boot-candidates";
  const bootBase = await callEndpoint(
    `/v1/memory_boot?namespace=${nsCandidates}&start=2026-11-23T00:00:00.000Z&end=2026-11-23T23:59:59.999Z`
  );
  await rawDb
    .prepare(
      `WITH RECURSIVE ids(n) AS (
         VALUES(1) UNION ALL SELECT n + 1 FROM ids WHERE n < 10000
       )
       INSERT INTO memory_candidates(id, namespace, type, content, source, status, created_at, updated_at)
       SELECT 'cand-' || n, ?1, 'fact', 'Synthetic candidate', 'import_entries', 'pending',
              '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z'
       FROM ids`
    )
    .bind(nsCandidates)
    .run();

  const bootCandidates = await callEndpoint(
    `/v1/memory_boot?namespace=${nsCandidates}&start=2026-11-23T00:00:00.000Z&end=2026-11-23T23:59:59.999Z`
  );
  assert.equal(bootCandidates.body.data.stats.pending_candidates, 0);
  assert.equal(bootCandidates.body.data.stats.pending_import_candidates, 10000);
  assert.ok(
    bootCandidates.rowsRead < 50 && bootCandidates.rowsRead <= bootBase.rowsRead + 15,
    `#141 candidates boot rows_read grew: base=${bootBase.rowsRead}, backlog=${bootCandidates.rowsRead}`
  );

  // --- #141b: 10,000 messages in today's range ---
  const nsMessages = "perf-boot-messages";
  await rawDb
    .prepare(
      `WITH RECURSIVE ids(n) AS (
         VALUES(1) UNION ALL SELECT n + 1 FROM ids WHERE n < 10000
       )
       INSERT INTO messages(id, conversation_id, namespace, role, content, created_at)
       SELECT 'msg-' || n, 'conv-1', ?1, 'user', 'Synthetic message', '2026-11-23T10:30:00.000Z'
       FROM ids`
    )
    .bind(nsMessages)
    .run();

  const bootMessages = await callEndpoint(
    `/v1/memory_boot?namespace=${nsMessages}&start=2026-11-23T00:00:00.000Z&end=2026-11-23T23:59:59.999Z`
  );
  assert.equal(bootMessages.body.data.stats.today_raw_count, 10000);
  assert.equal(bootMessages.body.data.today_messages.length, 160);
  assert.ok(
    bootMessages.rowsRead < 400,
    `#141 messages boot rows_read grew: ${bootMessages.rowsRead} (expected bounded by 160-row message slice)`
  );
});
