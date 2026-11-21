import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { test, type TestContext } from "node:test";
import { handleMcp } from "../src/api/mcp";
import { handleMemoryCandidates } from "../src/api/memories/candidates";
import { writeCursor } from "../src/db/retention";
import { invalidateKnownInputs } from "../src/db/v2/revocation";
import { runCandidateJudge } from "../src/memory/candidateJudge";
import { CLEF_MODEL } from "../src/memory/clefJudge";
import { runDailyMemoryDigest } from "../src/memory/dream/orchestrator";
import { runRollingWindow } from "../src/memory/rolling/runner";
import type { Env } from "../src/types";
import { insertLine, NOVEL, SYNTHETIC_DAY } from "./support/rolling-fixture";
import { sqliteFixture } from "./support/sqlite";

Object.assign(crypto.subtle, { timingSafeEqual });
const namespace = "default";
const scope = "user/lab/protocol";
const at = (hour: number, day = SYNTHETIC_DAY) => `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;

function decision(value: string, id: string, quote: string, key = scope) {
  return {
    type: "decision",
    content: `用户决定用 ${value}。`,
    attributed_role: "user" as const,
    evidence_quote: quote,
    source_message_ids: [id],
    decision: { scope_key: key, value, state_of: [] }
  };
}

function fixture(t: TestContext) {
  const { sqlite, db } = sqliteFixture(t);
  const reviews: string[] = [];
  const extractorPrompts: string[] = [];
  let tail: ReturnType<typeof decision> | undefined;
  let duringReview: (() => Promise<unknown>) | undefined;
  const env: Env = {
    DB: db, DREAM_TIME_ZONE: "UTC", ROLLING_WINDOW_MESSAGES: "1", CHATBOX_API_KEY: "synthetic-owner",
    AI: {
      async run(model: string, input: { state?: unknown; messages?: Array<{ content: string }> }) {
        if (model === CLEF_MODEL) {
          reviews.push(JSON.stringify(input.state));
          await duringReview?.();
          return { answers: { grounded: { noul: 0.9 }, worth: { noul: 0.9 } } };
        }
        if (model.includes("bge")) return { data: [[1, 0]] };
        const [system, prompt] = input.messages ?? [];
        if (system?.content.includes("no reasoning")) return { response: { title: "Lab", summary: "A day in the lab." } };
        extractorPrompts.push(prompt?.content ?? "");
        return { response: { memories: tail ? [tail] : [] } };
      }
    } as unknown as Env["AI"]
  };
  const roll = async (id: string, value: string, quote: string, date: string, key = scope, op: "new" | "no_op" = "new") => {
    insertLine(sqlite, id, quote, { at: date });
    return runRollingWindow(env, namespace, {
      triage: { async classify() { return NOVEL; } },
      extractor: { async extract() { return { events: [{ ...decision(value, id, quote, key), op, evidence_ids: [id] }], state_delta: {} }; } }
    });
  };
  const markDone = (day = SYNTHETIC_DAY) => writeCursor(db, `dream:${namespace}:${day}`, `done:${at(23, day)}`);
  const candidates = () => sqlite.prepare("SELECT * FROM memory_candidates ORDER BY id").all();
  const memories = () => sqlite.prepare("SELECT * FROM memories ORDER BY created_at").all();
  return { sqlite, env, roll, markDone, candidates, memories, reviews, extractorPrompts,
    setTail: (value: typeof tail) => { tail = value; },
    setReviewHook: (value: typeof duringReview) => { duringReview = value; } };
}

test("a partial day waits, then the nightly tail wins over earlier choices and hypothetical questions", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at(20)) });
  const f = fixture(t);
  await f.roll("morning", "ACP", "早上我决定用 ACP。", at(8));
  const slot = f.candidates()[0].id;
  await f.roll("noon", "SDK", "中午我决定改用 SDK。", at(12));
  await f.roll("question", "REST", "要不要改用 REST？", at(16));
  assert.equal(f.candidates().length, 1);
  assert.equal(f.candidates()[0].id, slot);
  assert.deepEqual(JSON.parse(String(f.candidates()[0].source_message_ids)), ["noon"]);
  await f.markDone();
  assert.equal((await runCandidateJudge(f.env, namespace)).reason, "no_candidates");
  assert.equal(f.reviews.length, 0);
  assert.equal(f.memories().length, 0);

  t.mock.timers.setTime(Date.parse(at(4, "2026-11-18")));
  const quote = "晚上还是用 ACP。";
  insertLine(f.sqlite, "evening", quote, { at: at(18) });
  assert.equal((await runCandidateJudge(f.env, namespace)).kept, 1);
  assert.equal(f.reviews.length, 0);
  f.setTail(decision("ACP", "evening", quote));
  assert.equal((await runDailyMemoryDigest(f.env, namespace, { dateLabel: SYNTHETIC_DAY })).ran, true);
  assert.equal(f.extractorPrompts.length, 1);
  assert.match(f.extractorPrompts[0], /Existing and pending decision scopes.*user\/lab\/protocol/);
  assert.equal(f.candidates()[0].id, slot);
  assert.equal((await runCandidateJudge(f.env, namespace)).approved, 1);
  assert.equal(f.reviews.length, 1);
  assert.match(f.reviews[0], /晚上还是用 ACP/);
  assert.doesNotMatch(f.reviews[0], /中午|早上/);
  assert.equal(f.memories().length, 1);
  const [current] = f.memories();
  assert.equal(current.fact_key, `decision:${scope}`);
  assert.deepEqual(JSON.parse(String(current.provenance)).inputs, ["message:evening"]);

  await f.roll("late", "REST", "我决定用 REST。", at(22));
  assert.equal((await runCandidateJudge(f.env, namespace)).reason, "no_candidates");
  assert.equal(f.memories().length, 1);
  assert.equal(f.candidates()[0].status, "approved");
  assert.equal(f.reviews.length, 1);

  await invalidateKnownInputs(f.env, { namespace, id: "noon" }, "message");
  assert.equal(f.memories()[0].status, "active");
  await invalidateKnownInputs(f.env, { namespace, id: "evening" }, "message");
  assert.equal(f.memories()[0].status, "archived");
  assert.equal((await runCandidateJudge(f.env, namespace)).reason, "no_candidates");
});

test("scopes stay independent and a return to an earlier value still creates the day's only version", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at(4, "2026-11-20")) });
  const f = fixture(t);
  await f.roll("before", "SDK", "我决定用 SDK。", at(9, "2026-11-16"));
  await f.markDone("2026-11-16");
  assert.equal((await runCandidateJudge(f.env, namespace)).approved, 1);
  const previous = f.memories()[0].id;
  await f.roll("am", "ACP", "我们决定用 ACP。", at(8));
  await f.roll("mid", "SDK", "我决定改用 SDK。", at(13));
  await f.roll("back", "ACP", "最后用 ACP。", at(18), scope, "no_op");
  await f.roll("other", "REST", "我决定另一个项目用 REST。", at(19), "user/tools/protocol");
  await f.markDone();
  assert.equal((await runCandidateJudge(f.env, namespace)).approved, 2);
  const records = f.memories();
  assert.equal(records.length, 3);
  const old = records.find(row => row.id === previous);
  const active = records.find(row => row.fact_key === `decision:${scope}` && row.status === "active");
  assert.equal(old?.status, "superseded");
  assert.equal(old?.superseded_by, active?.id);
  assert.match(String(active?.content), /ACP/);
  assert.deepEqual(JSON.parse(String(active?.source_message_ids)), ["back"]);
  assert.ok(records.some(row => row.fact_key === "decision:user/tools/protocol" && row.status === "active"));
  assert.equal(f.reviews.length, 3);
});

test("conflicting confirmations at the same instant wait for review", async (t) => {
  const f = fixture(t);
  await f.roll("left", "ACP", "我决定用 ACP。", at(8));
  await f.roll("right", "SDK", "我决定用 SDK。", at(8));
  await f.markDone();
  assert.equal((await runCandidateJudge(f.env, namespace)).kept, 1);
  assert.equal(f.candidates()[0].decision_note, "daily_decision_ambiguous");
  assert.equal(f.reviews.length, 0);
  assert.equal(f.memories().length, 0);
});

test("a new confirmation during review invalidates the old write and can be reviewed on retry", async (t) => {
  const f = fixture(t);
  await f.roll("old", "ACP", "我决定用 ACP。", at(8));
  await f.markDone();
  f.setReviewHook(() => f.roll("new", "SDK", "我决定改用 SDK。", at(18)));
  assert.equal((await runCandidateJudge(f.env, namespace)).failed, 1);
  assert.equal(f.memories().length, 0);
  assert.equal(f.candidates()[0].status, "pending");
  assert.deepEqual(JSON.parse(String(f.candidates()[0].source_message_ids)), ["new"]);
  f.setReviewHook(undefined);
  assert.equal((await runCandidateJudge(f.env, namespace)).approved, 1);
  assert.equal(f.memories().length, 1);
  assert.match(String(f.memories()[0].content), /SDK/);
});

const owner = { authorization: "Bearer synthetic-owner", "content-type": "application/json" };

test("a person reviews a daily decision only after its day closes, and it becomes the next version", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at(20)) });
  const f = fixture(t);
  const review = (id: string, action: string, body: Record<string, unknown> = {}) =>
    handleMemoryCandidates(new Request(`https://aelios.test/v1/candidates/${id}/${action}`, {
      method: "POST", headers: owner, body: JSON.stringify(body)
    }), f.env);
  const mcpReview = async (id: string, decision: string) => {
    const response = await handleMcp(new Request("https://aelios.test/mcp?tools=all", {
      method: "POST", headers: owner,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "memory_review", arguments: { id, decision } } })
    }), f.env, { waitUntil() {} } as unknown as ExecutionContext);
    return (await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
  };
  const pending = (day: string) => f.candidates().find(row =>
    JSON.parse(String(row.provenance)).daily_decision.date === day);

  await f.roll("before", "SDK", "我决定用 SDK。", at(9, "2026-11-16"));
  await f.markDone("2026-11-16");
  assert.equal((await review(String(pending("2026-11-16")?.id), "approve")).status, 200);
  const previous = f.memories()[0];
  assert.equal(previous.fact_key, `decision:${scope}`);

  await f.roll("am", "ACP", "我决定用 ACP。", at(8));
  const today = String(pending(SYNTHETIC_DAY)?.id);
  for (const action of ["approve", "discard"]) {
    const early = await review(today, action);
    assert.equal(early.status, 409);
    assert.match(await early.text(), new RegExp(SYNTHETIC_DAY));
  }
  assert.equal((await mcpReview(today, "approve")).isError, true);
  await f.roll("pm", "REST", "我决定改用 REST。", at(18));
  assert.equal(pending(SYNTHETIC_DAY)?.status, "pending");

  t.mock.timers.setTime(Date.parse(at(4, "2026-11-18")));
  await f.markDone();
  assert.equal((await review(today, "approve", { content: "用户决定用 gRPC。" })).status, 409);
  assert.equal((await review(today, "merge")).status, 409);
  const saved = await mcpReview(today, "approve");
  assert.equal(saved.isError, undefined);
  const memoryId = JSON.parse(saved.content[0].text).data.memory_id;
  const current = f.memories().find(row => row.id === memoryId);
  assert.equal(current?.status, "active");
  assert.equal(current?.fact_key, `decision:${scope}`);
  assert.match(String(current?.content), /REST/);
  assert.deepEqual(JSON.parse(String(current?.source_message_ids)), ["pm"]);
  assert.equal(JSON.parse(String(current?.provenance)).recording_actor, "mcp_review");
  assert.equal(f.memories().find(row => row.id === previous.id)?.status, "superseded");
  assert.equal(pending(SYNTHETIC_DAY)?.status, "approved");
  assert.equal(f.reviews.length, 0);
});
