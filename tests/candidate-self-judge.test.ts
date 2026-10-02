import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { invalidateSettingsCache, validateConfig } from "../src/gateway/config";
import { parseJudgeNote, runCandidateJudge } from "../src/memory/candidateJudge";
import { callableModelName, resolveJudgeVoice } from "../src/memory/judgeVoice";

// The candidate judge with each assistant judging its own space, plus the undo path.
(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);
let sqlite: DatabaseSync;
let env: any;
let calls: { url: string; headers: Record<string, string>; body: any }[];
let verdicts: any[];

const danjiu = () => ({ slug: "danjiu", namespace: "default", keys: ["CHATBOX_API_KEY"], models: ["*fable*", "*opus*"],
  userName: "咲咲", assistantName: "旦九" });
function setConfig(identities: any[] = [danjiu()], address = "https://upstream.test/ai/v1") {
  env.GATEWAY_CONFIG = JSON.stringify({ version: 3, upstream: { address }, identities });
}

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
  calls = []; verdicts = [];
  env = { DB: db, CHATBOX_API_KEY: "owner-key", CLOUDFLARE_API_TOKEN: "cf-token",
    DREAM_MODEL: "workers-ai/@cf/openai/gpt-oss-120b",
    AI: { async run(model: string) {
      if (model.includes("bge")) return { data: [[0.1, 0.2, 0.3]] };
      // The shared judge (Workers AI) answers with the next queued verdict too.
      calls.push({ url: `workers-ai:${model}`, headers: {}, body: null });
      return { response: JSON.stringify(verdicts.shift()) };
    } },
    VECTORIZE: { async upsert() { return {}; }, async deleteByIds() { return {}; }, async query() { return { matches: [] }; } } };
  globalThis.fetch = async (url: any, init: any) => {
    const body = JSON.parse(init?.body as string);
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)), body });
    const text = JSON.stringify(verdicts.shift());
    if (String(url).endsWith("/messages")) return Response.json({ model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: "end_turn" });
    if (String(url).endsWith("/responses")) return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] });
    return Response.json({ choices: [{ index: 0, message: { content: text }, finish_reason: "stop" }] });
  };
  setConfig();
});

const now = () => new Date().toISOString();
function exchange(profile: string, protocol: string, model: string, provider = "", kind = "human", at = now()) {
  sqlite.prepare(`INSERT INTO gateway_exchanges (id, namespace, profile, conversation_id, protocol, kind, user_text, assistant_text,
    upstream_model, upstream_provider, http_status, completion_status, created_at) VALUES (?, ?, ?, 'c', ?, ?, '', '', ?, ?, 200, 'complete', ?)`)
    .run(`ex-${Math.random()}`, "default", profile, protocol, kind, model, provider, at);
}
function message(id: string, role: string, content: string) {
  sqlite.prepare(`INSERT INTO messages (id, conversation_id, namespace, role, content, source, created_at, seq)
    VALUES (?, 'c', 'default', ?, ?, 'gateway:danjiu', ?, 0)`).run(id, role, content, now());
}
function candidate(id: string, content: string, extra: { source?: string; fact_key?: string; target?: string; created?: string } = {}) {
  sqlite.prepare(`INSERT INTO memory_candidates (id, namespace, type, content, fact_key, confidence, importance, tags,
    source_message_ids, source, status, target_memory_id, created_at, updated_at)
    VALUES (?, 'default', 'fact', ?, ?, 0.5, 0.6, '[]', '["m1"]', ?, 'pending', ?, ?, ?)`)
    .run(id, content, extra.fact_key ?? null, extra.source ?? "dream_add", extra.target ?? null, extra.created ?? now(), extra.created ?? now());
}
function memory(id: string, content: string, factKey: string | null = null, created = "2026-09-01T00:00:00.000Z") {
  sqlite.prepare(`INSERT INTO memories (id, namespace, type, content, importance, confidence, status, pinned, tags, source,
    source_message_ids, vector_id, created_at, updated_at, fact_key, version_status)
    VALUES (?, 'default', 'fact', ?, 0.6, 0.8, 'active', 0, '[]', 'dream', '[]', ?, ?, ?, ?, 'current')`)
    .run(id, content, `mem_${id}`, created, created, factKey);
  sqlite.prepare("INSERT INTO memory_lifecycle (memory_id, namespace, fact_key, seen_count) VALUES (?, 'default', ?, 0)").run(id, factKey);
}
const row = (table: string, id: string, key = "id") => sqlite.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`).get(id) as any;
const verdict = (score: number, grounded = true, extra: any = {}) =>
  ({ score, grounded, durable: true, should_delete: false, reason: "我想记住这件事。", ...extra });
async function api(path: string, method = "GET") {
  const response = await worker.fetch(new Request(`https://aelios.test${path}`, { method,
    headers: { authorization: "Bearer owner-key", "content-type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}) }), env, { waitUntil() {} } as any);
  return { status: response.status, body: await response.json() as any };
}

test("the assistant's own voice comes from its latest main-model exchange", async () => {
  assert.equal(callableModelName("claude-opus-5-5", "anthropic"), "anthropic/claude-opus-5-5");
  assert.equal(callableModelName("openai/gpt-6.1-sol-pro", ""), "openai/gpt-6.1-sol-pro");
  assert.equal(callableModelName("claude-opus-5-5", ""), null);

  assert.deepEqual(await resolveJudgeVoice(env, "default"), { kind: "shared", model: "workers-ai/@cf/openai/gpt-oss-120b" });

  exchange("danjiu", "messages", "claude-opus-5-5", "anthropic", "human", "2026-10-01T01:00:00.000Z");
  exchange("danjiu", "chat", "anthropic/claude-haiku-4-5", "", "human", "2026-10-01T02:00:00.000Z"); // not a main model
  exchange("danjiu", "chat", "anthropic/claude-fable-5-1", "", "auxiliary", "2026-10-01T03:00:00.000Z"); // auxiliary turn
  const voice: any = await resolveJudgeVoice(env, "default");
  assert.equal(voice.kind, "self");
  assert.equal(voice.name, "旦九");
  assert.equal(voice.protocol, "messages");
  assert.equal(voice.model, "anthropic/claude-opus-5-5");

  setConfig([{ ...danjiu(), judgeModel: "deepseek/deepseek-v4-flash" }]);
  invalidateSettingsCache();
  const pinned: any = await resolveJudgeVoice(env, "default");
  assert.equal(pinned.protocol, "chat");
  assert.equal(pinned.model, "deepseek/deepseek-v4-flash");

  assert.throws(() => validateConfig({ version: 3, identities: [{ ...danjiu(), judgeModel: "no-author" }] }), /judgeModel/);

  // Two assistants sharing a space: whoever spoke last judges, with its own pin if it has one.
  setConfig([danjiu(), { slug: "guest", namespace: "default", keys: ["CHATBOX_API_KEY"], models: ["*sol*"],
    assistantName: "知来", judgeModel: "openai/gpt-6.1-sol" }]);
  invalidateSettingsCache();
  exchange("guest", "responses", "openai/gpt-6.1-sol-pro", "", "human", "2026-09-30T01:00:00.000Z");
  const last: any = await resolveJudgeVoice(env, "default");
  assert.deepEqual([last.name, last.model, last.protocol], ["旦九", "anthropic/claude-opus-5-5", "messages"]);
  exchange("guest", "responses", "openai/gpt-6.1-sol-pro", "", "human", "2026-10-01T04:00:00.000Z");
  const guest: any = await resolveJudgeVoice(env, "default");
  assert.deepEqual([guest.name, guest.model, guest.protocol], ["知来", "openai/gpt-6.1-sol", "chat"]);
});

test("SELF_JUDGE_ENABLED=false keeps main models out of judging", async () => {
  exchange("danjiu", "messages", "claude-opus-5-5", "anthropic");
  env.SELF_JUDGE_ENABLED = "false";
  assert.deepEqual(await resolveJudgeVoice(env, "default"), { kind: "shared", model: "workers-ai/@cf/openai/gpt-oss-120b" });

  // A judge model picked for the assistant is still its own, cheaper voice.
  setConfig([{ ...danjiu(), judgeModel: "deepseek/deepseek-v4-flash" }]);
  invalidateSettingsCache();
  const pinned: any = await resolveJudgeVoice(env, "default");
  assert.deepEqual([pinned.kind, pinned.name, pinned.model, pinned.protocol], ["self", "旦九", "deepseek/deepseek-v4-flash", "chat"]);
});

test("self-judge decides remember or let go, through the assistant's own route", async () => {
  setConfig([danjiu()], "d121aa7cd60ccebd6213c931efce41da");
  exchange("danjiu", "messages", "claude-opus-5-5", "anthropic");
  message("m1", "user", "我下周三去复查肾功能。");
  candidate("c-keep", "咲咲下周三去复查肾功能。", { created: "2026-09-30T10:00:00.000Z" });
  candidate("c-drop", "咲咲今天说了你好。", { created: "2026-09-30T11:00:00.000Z" });
  // listMemoryCandidates orders by confidence then created_at DESC: c-drop first.
  verdicts.push(verdict(0.3, true, { reason: "我觉得只是寒暄，不用记。" }), verdict(0.6));

  const result = await runCandidateJudge(env, "default");
  assert.equal(result.judgedBy, "旦九");
  assert.equal(result.model, "anthropic/claude-opus-5-5");
  assert.deepEqual([result.approved, result.discarded, result.kept, result.failed], [1, 1, 0, 0]);

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/anthropic\/v1\/messages$/);
  assert.equal(calls[0].headers["cf-aig-authorization"], "Bearer cf-token");
  assert.equal(calls[0].body.model, "claude-opus-5-5");
  assert.match(calls[0].body.messages[0].content, /你是旦九。/);
  assert.match(calls[0].body.messages[0].content, /用「我」指你自己/);

  const keep = row("memory_candidates", "c-keep");
  assert.equal(keep.status, "approved");
  assert.equal(keep.decision_note, "judge[旦九]: 我想记住这件事。");
  assert.equal(row("memories", keep.target_memory_id).status, "active");
  const drop = row("memory_candidates", "c-drop");
  assert.equal(drop.status, "discarded");
  assert.deepEqual(parseJudgeNote(drop.decision_note), { judgedBy: "旦九", reason: "我觉得只是寒暄，不用记。", undone: false, undoable: true });
});

test("the shared judge keeps its middle band for people", async () => {
  message("m1", "user", "我下周三去复查肾功能。");
  candidate("c-mid", "咲咲下周三去复查肾功能。");
  verdicts.push(verdict(0.6));
  const result = await runCandidateJudge(env, "default");
  assert.equal(result.judgedBy, undefined);
  assert.equal(result.kept, 1);
  assert.equal(calls[0].url, "workers-ai:@cf/openai/gpt-oss-120b");
  const mid = row("memory_candidates", "c-mid");
  assert.equal(mid.status, "pending");
  assert.equal(mid.decision_note, "judge: 我想记住这件事。");
});

test("decisions list and undo both ways", async () => {
  exchange("danjiu", "chat", "anthropic/claude-opus-5-5");
  message("m1", "user", "我搬进自己装修的旧房子了。");
  memory("old", "咲咲住在出租屋。", "home");
  candidate("c-update", "咲咲搬进了自己装修的旧房子。", { source: "dream_update", fact_key: "home", created: "2026-09-30T10:00:00.000Z" });
  candidate("c-new", "咲咲喜欢杨枝甘露。", { created: "2026-09-30T11:00:00.000Z" });
  verdicts.push(verdict(0.2, false, { reason: "我找不到依据。" }), verdict(0.9));
  // c-new (created later) is judged first: discarded; c-update approved via supersede.
  await runCandidateJudge(env, "default");

  const updated = row("memory_candidates", "c-update");
  assert.equal(updated.status, "approved");
  const replacement = updated.target_memory_id;
  assert.equal(row("memories", "old").status, "superseded");

  const list = await api("/v1/candidates/decisions?days=7&namespace=default");
  assert.equal(list.status, 200);
  const byId = Object.fromEntries(list.body.data.map((d: any) => [d.id, d]));
  assert.equal(list.body.data.length, 2);
  assert.deepEqual([byId["c-update"].status, byId["c-update"].judged_by, byId["c-update"].undoable], ["approved", "旦九", true]);
  assert.deepEqual([byId["c-new"].status, byId["c-new"].reason, byId["c-new"].undoable], ["discarded", "我找不到依据。", true]);

  // Undo the remembered update: the new version is archived, the old one comes back.
  const undoUpdate = await api("/v1/candidates/c-update/undo?namespace=default", "POST");
  assert.equal(undoUpdate.status, 200);
  assert.equal(undoUpdate.body.data.status, "discarded");
  assert.equal(undoUpdate.body.data.restored_id, "old");
  assert.equal(row("memories", replacement).status, "archived");
  const restored = row("memories", "old");
  assert.equal(restored.status, "active");
  assert.equal(restored.version_status, "current");
  assert.equal(restored.superseded_by, null);
  assert.equal(row("memory_lifecycle", "old", "memory_id").superseded_by_id, null);

  // Undo the let-go: it gets remembered after all.
  const undoNew = await api("/v1/candidates/c-new/undo?namespace=default", "POST");
  assert.equal(undoNew.status, 200);
  assert.equal(undoNew.body.data.status, "approved");
  const remembered = row("memories", undoNew.body.data.memory_id);
  assert.equal(remembered.content, "咲咲喜欢杨枝甘露。");
  assert.equal(remembered.source, "review");

  // Undone decisions stay listed but cannot be undone twice.
  const again = await api("/v1/candidates/c-new/undo?namespace=default", "POST");
  assert.equal(again.status, 409);
  const after = await api("/v1/candidates/decisions?days=7&namespace=default");
  assert.ok(after.body.data.every((d: any) => d.undone && !d.undoable));
});

test("undo restores an archived memory and refuses what changed since", async () => {
  exchange("danjiu", "chat", "anthropic/claude-opus-5-5");
  message("m1", "user", "我已经不喝越南咖啡了。");
  memory("coffee", "咲咲爱喝越南咸咖啡。");
  candidate("c-del", "咲咲爱喝越南咸咖啡。", { source: "dream_delete", target: "coffee", created: "2026-09-30T10:00:00.000Z" });
  verdicts.push(verdict(0.9, true, { should_delete: true, reason: "她说不喝了，我把这条收起来。" }));
  await runCandidateJudge(env, "default");
  assert.equal(row("memories", "coffee").status, "archived");

  const undo = await api("/v1/candidates/c-del/undo?namespace=default", "POST");
  assert.equal(undo.status, 200);
  assert.equal(row("memories", "coffee").status, "active");
  assert.equal(row("memory_candidates", "c-del").status, "discarded");

  // A remembered memory that was edited away afterwards is left alone.
  candidate("c-gone", "咲咲在学中级经济师。", { fact_key: "exam", created: "2026-09-30T10:00:00.000Z" });
  verdicts.push(verdict(0.9));
  await runCandidateJudge(env, "default");
  const gone = row("memory_candidates", "c-gone");
  sqlite.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(gone.target_memory_id);
  const refused = await api("/v1/candidates/c-gone/undo?namespace=default", "POST");
  assert.equal(refused.status, 409);

  // A remembered memory edited in place afterwards (same id, same created_at) is left alone,
  // so the later edit is not archived with it.
  candidate("c-edited", "咲咲在学中级经济师。", { fact_key: "exam-edited", created: "2026-09-30T10:00:00.000Z" });
  verdicts.push(verdict(0.9));
  await runCandidateJudge(env, "default");
  const edited = row("memory_candidates", "c-edited");
  sqlite.prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?")
    .run("咲咲 11-07 考中级经济师。", new Date(Date.now() + 60_000).toISOString(), edited.target_memory_id);
  assert.equal((await api("/v1/candidates/c-edited/undo?namespace=default", "POST")).status, 409);
  assert.equal(row("memories", edited.target_memory_id).status, "active");

  // Flagged for review overnight (fresh updated_at, same content) is not an edit: undo still works.
  candidate("c-review", "咲咲在学人工智能训练师。", { fact_key: "ai-cert", created: "2026-09-30T10:00:00.000Z" });
  verdicts.push(verdict(0.9));
  await runCandidateJudge(env, "default");
  const review = row("memory_candidates", "c-review");
  sqlite.prepare("UPDATE memories SET version_status = 'under_review', updated_at = ? WHERE id = ?")
    .run(new Date(Date.now() + 60_000).toISOString(), review.target_memory_id);
  assert.equal((await api("/v1/candidates/c-review/undo?namespace=default", "POST")).status, 200);
  assert.equal(row("memories", review.target_memory_id).status, "archived");

  // A memory that has become hand-authored is left alone too.
  candidate("c-hand", "咲咲在学营销师。", { fact_key: "cert", created: "2026-09-30T10:00:00.000Z" });
  verdicts.push(verdict(0.9));
  await runCandidateJudge(env, "default");
  const hand = row("memory_candidates", "c-hand");
  sqlite.prepare("UPDATE memories SET authored_by = '咲咲' WHERE id = ?").run(hand.target_memory_id);
  assert.equal((await api("/v1/candidates/c-hand/undo?namespace=default", "POST")).status, 409);
  assert.equal(row("memories", hand.target_memory_id).status, "active");

  // Undoing a declined archive needs the memory to still be there.
  candidate("c-del-gone", "咲咲住在出租屋。", { source: "dream_delete", target: "missing", created: "2026-09-30T10:00:00.000Z" });
  sqlite.prepare("UPDATE memory_candidates SET status = 'discarded', decision_note = 'judge[旦九]: 我想留着。' WHERE id = 'c-del-gone'").run();
  assert.equal((await api("/v1/candidates/c-del-gone/undo?namespace=default", "POST")).status, 409);

  // A remembered update whose old version was touched since is refused before anything moves.
  memory("city-old", "咲咲住在香港。", "city");
  candidate("c-city", "咲咲长期住在武汉。", { source: "dream_update", fact_key: "city", created: "2026-09-30T10:00:00.000Z" });
  verdicts.push(verdict(0.9));
  await runCandidateJudge(env, "default");
  const city = row("memory_candidates", "c-city");
  assert.equal(row("memories", "city-old").status, "superseded");
  sqlite.prepare("UPDATE memories SET status = 'archived' WHERE id = 'city-old'").run();
  assert.equal((await api("/v1/candidates/c-city/undo?namespace=default", "POST")).status, 409);
  assert.equal(row("memories", city.target_memory_id).status, "active");

  // An archive is not undone once the fact has a newer current version.
  memory("pet-old", "咲咲养了一只猫。", "pet");
  candidate("c-pet", "咲咲养了一只猫。", { source: "dream_delete", target: "pet-old", created: "2026-09-30T10:00:00.000Z" });
  verdicts.push(verdict(0.9, true, { should_delete: true }));
  await runCandidateJudge(env, "default");
  assert.equal(row("memories", "pet-old").status, "archived");
  memory("pet-new", "咲咲养了两只猫。", "pet");
  assert.equal((await api("/v1/candidates/c-pet/undo?namespace=default", "POST")).status, 409);
  assert.equal(row("memories", "pet-old").status, "archived");

  // Human decisions are not this endpoint's to reverse.
  candidate("c-human", "咲咲住在武汉。");
  sqlite.prepare("UPDATE memory_candidates SET status = 'discarded', decision_note = 'discarded' WHERE id = 'c-human'").run();
  assert.equal((await api("/v1/candidates/c-human/undo?namespace=default", "POST")).status, 409);
});
