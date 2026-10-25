import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createVectorMemory, updateVectorMemory } from "../src/memory/vectorStore";
import { runRecall } from "../src/memory/v2/recall";
import { searchMemoriesWithProvenance } from "../src/memory/search";

let sqlite: DatabaseSync;
let env: any;
let queryHandler: (vector: number[], options: any) => any;
let deleted: string[][];
let rerankerCalls: any[];

beforeEach(() => {
  sqlite?.close();
  sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
    try {
      sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
    } catch (error) {
      if (!String(error).includes("fts5")) throw error;
    }
  }
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let args: any[] = [];
      const api = {
        bind(...values: any[]) {
          args = values;
          return api;
        },
        async first() {
          return statement.get(...args) || null;
        },
        async all() {
          return { results: statement.all(...args) };
        },
        async run() {
          const result = statement.run(...args);
          return { meta: { changes: result.changes } };
        }
      };
      return api;
    },
    async batch(statements: any[]) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  };
  queryHandler = () => ({ matches: [] });
  deleted = [];
  rerankerCalls = [];
  env = {
    DB: db,
    RECALL_WEEK_BLOCKS: "false",
    AI: {
      async run(model: string, input: any) {
        if (model.includes("reranker")) {
          rerankerCalls.push(input);
          return {
            response: input.contexts.map((context: any, id: number) => ({
              id,
              score: context.text.includes("触发器记忆") ? 0.99 : 0.8
            }))
          };
        }
        return { data: [[0.1, 0.2, 0.3]] };
      }
    },
    VECTORIZE: {
      async query(vector: number[], options: any) {
        return queryHandler(vector, options);
      },
      async upsert() {
        return {};
      },
      async getByIds() {
        return [{ values: [0.1, 0.2, 0.3] }];
      },
      async deleteByIds(ids: string[]) {
        deleted.push(ids);
        return {};
      }
    }
  };
});

async function memory(content: string) {
  return createVectorMemory(env, {
    namespace: "default",
    type: "fact",
    content,
    importance: 0.5,
    confidence: 0.8,
    tags: [],
    source: "test",
    sourceMessageIds: []
  });
}

test("a Vectorize failure still returns lexical matches", async () => {
  await memory("咲咲喜欢越南咖啡");
  queryHandler = () => {
    throw new Error("Vectorize unavailable");
  };
  const result = await searchMemoriesWithProvenance(env, { namespace: "default", query: "越南咖啡", topK: 3 });
  assert.ok(result.records.some((record) => record.content === "咲咲喜欢越南咖啡"));
});

test("trigger candidates reach the reranker when the ordinary pool is already full", async () => {
  for (let index = 0; index < 12; index += 1) await memory(`共同问题 普通记忆 ${index}`);
  const triggered = await memory("触发器记忆：海鲜过敏");
  sqlite.prepare(`INSERT INTO memory_triggers (namespace, memory_id, concept, bridge, confidence, vector_id, created_at)
    VALUES ('default', ?, '海鲜', '海鲜 -> 过敏', 0.9, 'trg_vec', '2026-10-01')`).run(triggered.id);
  queryHandler = (_vector, options) => {
    if (options.namespace !== "trg:default") return { matches: [] };
    return {
      matches: [{
        id: "trg_vec_concept",
        score: 0.96,
        metadata: {
          namespace: "trg:default",
          kind: "trigger",
          memory_ns: "default",
          trigger_key: "trg_vec",
          ref_id: triggered.id,
          concept: "海鲜",
          view: "concept",
          confidence: 0.9
        }
      }]
    };
  };
  env.TRIGGER_RECALL = "on";
  env.MEMORY_FILTER_MAX_CANDIDATES = "2";

  const result = await runRecall(env, { namespace: "default", query: "共同问题", k: 12, skip_inject_mark: true });

  assert.ok(rerankerCalls.some((call) => call.contexts.some((context: any) => context.text.includes("触发器记忆"))));
  assert.ok(result.hits.some((hit) => hit.id === triggered.id));
});

test("LIKE longtail evidence is not removed by the vector score floor", async () => {
  sqlite.prepare("INSERT INTO longtail (id, namespace, content, ts) VALUES ('lt1', 'default', '独特长尾证据', '2026-10-01')").run();
  const result = await runRecall(env, { namespace: "default", query: "独特长尾", skip_inject_mark: true });
  assert.deepEqual(result.hits.map((hit) => [hit.id, hit.source_layer]), [["lt1", "longtail"]]);
});

test("content edits clear stale triggers while metadata-only edits keep them", async () => {
  const first = await memory("旧正文");
  const insert = sqlite.prepare(`INSERT INTO memory_triggers (namespace, memory_id, concept, bridge, confidence, vector_id, created_at)
    VALUES ('default', ?, '旧触发器', '', 0.9, ?, '2026-10-01')`);
  insert.run(first.id, "old_trigger");
  await updateVectorMemory(env, first.id, { content: "新正文" });
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM memory_triggers WHERE memory_id = ?").get(first.id) as any).n, 0);
  assert.ok(deleted.flat().includes("old_trigger#c"));

  insert.run(first.id, "metadata_trigger");
  const before = deleted.length;
  await updateVectorMemory(env, first.id, { importance: 0.9 });
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM memory_triggers WHERE memory_id = ?").get(first.id) as any).n, 1);
  assert.equal(deleted.length, before);
});
