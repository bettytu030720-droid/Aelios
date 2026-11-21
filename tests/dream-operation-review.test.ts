import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { test, type TestContext } from "node:test";
import { handleMcp } from "../src/api/mcp";
import { handleMemoryCandidates } from "../src/api/memories/candidates";
import { cleanRawMessage } from "../src/db/v2/revocation";
import { runCandidateJudge } from "../src/memory/candidateJudge";
import { CLEF_MODEL } from "../src/memory/clefJudge";
import { UNCLASSIFIED_DREAM_SOURCE } from "../src/memory/provenance";
import { runRollingWindow } from "../src/memory/rolling/runner";
import { loadRollingState } from "../src/memory/rolling/state";
import type { Env } from "../src/types";
import { insertLine, NOVEL, SYNTHETIC_AT } from "./support/rolling-fixture";
import { sqliteFixture } from "./support/sqlite";

Object.assign(crypto.subtle, { timingSafeEqual });
const NS = "default";
const owner = { authorization: "Bearer synthetic-owner", "content-type": "application/json" };
const operations = ["add", "update", "archive", "no_op", "uncertain"];
const noul = (score: number) => ({ type: "noul", noul: score });

function actionAnswer(choice: string, score = 0.92, evidence = 0.9) {
  return {
    operation: {
      type: "choice", choice, confidence: score,
      probabilities: Object.fromEntries(operations.map(action => [action, action === choice ? score : (1 - score) / 4]))
    },
    grounded: noul(evidence), archive: noul(evidence)
  };
}

interface ReviewInput {
  state: { candidate: { action: string; reported_op?: string }; old_memory?: string; target_writable?: boolean; transcript: string };
  questions: Record<string, { type: string; criteria: Record<string, string> }>;
}

function operationFixture(t: TestContext) {
  const { sqlite, db } = sqliteFixture(t);
  const calls: ReviewInput[] = [];
  let modelOutput: Record<string, unknown>;
  let review: (input: ReviewInput) => unknown | Promise<unknown> = () => actionAnswer("add");
  let extractions = 0;
  const env: Env = {
    DB: db, CHATBOX_API_KEY: "synthetic-owner",
    ROLLING_WINDOW_MESSAGES: "1", DREAM_TIME_ZONE: "UTC", CURRENT_STATE_PROJECTION: "on",
    AI: {
      async run(model: string, input: ReviewInput) {
        if (model === CLEF_MODEL) {
          calls.push(input);
          return { answers: await review(input) };
        }
        if (model.includes("bge")) return { data: [[1, 0]] };
        assert.equal(model, "@cf/zai-org/glm-4.7-flash");
        extractions += 1;
        return { response: modelOutput };
      }
    } as unknown as Env["AI"],
    VECTORIZE: {
      async upsert() { return {}; },
      async deleteByIds() { return {}; }
    } as unknown as Env["VECTORIZE"]
  };
  const extract = (events: Record<string, unknown>[], stateDelta = {}) => {
    modelOutput = { events, state_delta: stateDelta };
    return runRollingWindow(env, NS, { triage: { async classify() { return NOVEL; } } });
  };
  const judge = (answer: typeof review) => {
    review = answer;
    return runCandidateJudge(env, NS);
  };
  async function api(path: string, method = "GET") {
    return handleMemoryCandidates(new Request(`https://aelios.test/v1/candidates${path}`, {
      method, headers: owner, ...(method === "POST" ? { body: "{}" } : {})
    }), env);
  }
  async function mcp(name: string, args = {}) {
    const response = await handleMcp(new Request("https://aelios.test/mcp?tools=all", {
      method: "POST", headers: owner,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
    }), env, { waitUntil() {} } as unknown as ExecutionContext);
    return (await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
  }
  const candidates = () => sqlite.prepare("SELECT * FROM memory_candidates ORDER BY rowid").all();
  const memory = (id: string) => sqlite.prepare("SELECT * FROM memories WHERE id=?").get(id);
  function target(source = "dream", namespace = NS) {
    sqlite.prepare(`INSERT INTO memories(id,namespace,type,content,source,version_status,fact_key,created_at,updated_at)
      VALUES('old',?,'fact','The lab meets on Tuesday.',?,'current','lab:day',?,?)`)
      .run(namespace, source, SYNTHETIC_AT, SYNTHETIC_AT);
    sqlite.prepare(`INSERT INTO memory_events(id,namespace,event_type,payload_json,created_at)
      VALUES('recall',?,'recall_explain',?,?)`).run(NS, JSON.stringify({ items: [{ namespace, id: "old" }] }), SYNTHETIC_AT);
  }
  return { sqlite, db, env, extract, judge, calls, api, mcp, candidates, memory, target, extractions: () => extractions };
}

const talk = "The observatory has a telescope.";
function event(op: string, text = talk, id = "line") {
  return { op, type: "fact", content: text, attributed_role: "user", evidence_ids: [id], evidence_quote: text };
}

test("default GLM keeps a grounded unfamiliar operation beside a known one and asks Clef once for each", async (t) => {
  const f = operationFixture(t);
  f.env.ROLLING_WINDOW_MESSAGES = "2";
  const other = "I decided to use a paper log.";
  insertLine(f.sqlite, "line", talk);
  insertLine(f.sqlite, "other", other);
  const known = { ...event("new"), episode_key: "lab" };
  const unfamiliar = { ...event("retain_with_applause", other, "other"), episode_key: "log", type: "decision",
    decision: { scope_key: "user/observatory/log", value: "paper", state_of: [] } };
  assert.equal((await f.extract([
    known, unfamiliar,
    { ...event("undefined_move"), evidence_quote: "A fabricated quote." },
    { ...event("another_move"), attributed_role: undefined },
    { ...event("new_move"), evidence_ids: ["invented"] }
  ], { episodes: [
    { key: "lab", label: "Observatory", evidence_ids: ["line"] },
    { key: "log", label: "Paper log", evidence_ids: ["other"] }
  ] })).extracted, true);
  assert.equal(f.extractions(), 1);
  const [normal, pending] = f.candidates();
  assert.deepEqual(f.candidates().map(row => row.source), ["dream_extract", UNCLASSIFIED_DREAM_SOURCE]);
  assert.deepEqual(JSON.parse(String(pending.provenance)).inputs, ["message:other"]);
  assert.equal(pending.target_memory_id, null);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get()?.n, 0);
  const { state } = await loadRollingState(f.env, NS);
  assert.deepEqual(state.episodes.map(episode => episode.key), ["lab"]);
  assert.deepEqual(state.changes, []);

  const result = await f.judge(input => input.questions.operation ? actionAnswer("add") : { grounded: noul(0.9), worth: noul(0.9) });
  assert.equal(result.approved, 2);
  assert.equal(f.calls.length, 2);
  const classified = f.calls.find(call => call.questions.operation);
  assert.ok(classified);
  assert.equal(classified.questions.operation.type, "choice");
  assert.equal(classified.questions.grounded.type, "noul");
  assert.deepEqual(Object.keys(classified.questions.operation.criteria), operations);
  assert.equal(classified.state.candidate.reported_op, "retain_with_applause");
  assert.match(JSON.stringify(classified.state.transcript), /paper log/);
  assert.doesNotMatch(JSON.stringify(classified.state.transcript), /telescope/);
  assert.deepEqual(Object.keys(f.calls.find(call => !call.questions.operation)?.questions ?? {}), ["grounded", "worth"]);
  const [approvedKnown, approvedRecovered] = f.candidates();
  assert.equal(approvedKnown.id, normal.id);
  assert.equal(approvedRecovered.source, "dream_add");
  assert.equal(f.memory(String(approvedRecovered.target_memory_id))?.content, other);
  assert.equal((await f.api(`/${approvedRecovered.id}/undo`, "POST")).status, 200);
  assert.equal(f.memory(String(approvedRecovered.target_memory_id))?.status, "archived");
});

for (const action of ["update", "archive"]) {
  test(`a recovered ${action} applies to the cited target and can be undone`, async (t) => {
    const f = operationFixture(t);
    f.target();
    const text = action === "update" ? "The lab now meets on Thursday." : "The lab no longer has a meeting day.";
    insertLine(f.sqlite, "line", text);
    await f.extract([{ ...event("unexpected_action", text), target_memory_id: "old" }]);
    const [pending] = f.candidates();
    const origin = JSON.parse(String(pending.provenance));
    assert.deepEqual(origin.inputs, ["message:line"]);
    assert.deepEqual(origin.context_refs, ["memory:old"]);
    assert.deepEqual(origin.proposed_operation.target, { id: "old", revision: SYNTHETIC_AT });
    assert.equal(pending.target_memory_id, null);
    assert.equal((await f.judge(() => actionAnswer(action))).approved, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].state.old_memory, "The lab meets on Tuesday.");
    const [approved] = f.candidates();
    assert.equal(approved.source, action === "update" ? "dream_update" : "dream_delete");
    assert.equal(f.memory("old")?.status, action === "update" ? "superseded" : "archived");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM memory_revocations").get()?.n, 0);
    if (action === "update") {
      const updated = f.memory(String(approved.target_memory_id));
      assert.equal(updated?.content, text);
      const reviewed = JSON.parse(String(updated?.provenance));
      assert.deepEqual(reviewed.inputs, ["message:line", "memory:old"]);
      assert.deepEqual(reviewed.context_refs, []);
    }
    assert.equal((await f.api(`/${pending.id}/undo`, "POST")).status, 200);
    assert.equal(f.memory("old")?.status, "active");
    assert.equal(f.calls.length, 1);
  });
}

test("ambiguous, weakly supported, and malformed Clef answers stay pending with a reason", async (t) => {
  const f = operationFixture(t);
  insertLine(f.sqlite, "line", talk);
  await f.extract([event("maybe_save")]);
  assert.equal((await f.judge(() => actionAnswer("add", 0.6))).kept, 1);
  assert.equal(f.candidates()[0].decision_note, "operation_uncertain");
  assert.equal((await f.judge(() => actionAnswer("add", 0.92, 0.2))).kept, 1);
  assert.equal((await f.judge(() => ({ operation: { type: "choice", choice: "invented" } }))).failed, 1);
  assert.equal(f.candidates()[0].decision_note, "operation_clef_failed");
  assert.equal(f.candidates()[0].status, "pending");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get()?.n, 0);

  await cleanRawMessage(f.db, NS, "line");
  assert.equal((await f.judge(() => assert.fail("no inference without conversation evidence"))).kept, 1);
  assert.equal(f.candidates()[0].decision_note, "operation_evidence_missing");
  assert.equal(f.calls.length, 3);
});

test("a stalled Clef classification times out and records the pending reason", async (t) => {
  const f = operationFixture(t);
  insertLine(f.sqlite, "line", talk);
  await f.extract([event("capture")]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let start = () => {};
  const started = new Promise<void>(resolve => { start = resolve; });
  const judgment = f.judge(() => {
    start();
    return new Promise(() => {});
  });
  await started;
  t.mock.timers.tick(30_000);
  assert.equal((await judgment).failed, 1);
  assert.equal(f.candidates()[0].status, "pending");
  assert.equal(f.candidates()[0].decision_note, "operation_clef_timeout");
});

test("a no-op is visible as a skipped review and has no mutation to undo", async (t) => {
  const f = operationFixture(t);
  insertLine(f.sqlite, "line", talk);
  await f.extract([event("pass_along")]);
  assert.equal((await f.judge(() => actionAnswer("no_op"))).discarded, 1);
  const [candidate] = f.candidates();
  const decisions = await (await f.api("/decisions")).json() as { data: Array<{ undoable: boolean }> };
  assert.equal(decisions.data[0].undoable, false);
  assert.equal((await f.api(`/${candidate.id}/undo`, "POST")).status, 409);
  assert.equal((await f.api(`/${candidate.id}/approve`, "POST")).status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get()?.n, 0);
});

test("a Clef archive cannot apply to a manually authored, pinned, changed, or foreign memory", async (t) => {
  for (const condition of ["manual", "pinned", "changed", "foreign"]) {
    await t.test(condition, async (subtest) => {
      const f = operationFixture(subtest);
      f.target(condition === "manual" ? "manual" : "dream", condition === "foreign" ? "another-space" : NS);
      insertLine(f.sqlite, "line", "The lab no longer has a meeting day.");
      await f.extract([{ ...event("retire", "The lab no longer has a meeting day."), target_memory_id: "old" }]);
      if (condition === "pinned") f.sqlite.exec("UPDATE memories SET pinned=1 WHERE id='old'");
      if (condition === "changed") f.sqlite.exec("UPDATE memories SET updated_at='2026-11-18' WHERE id='old'");
      assert.equal((await f.judge(() => actionAnswer("archive"))).kept, 1);
      assert.equal(f.calls[0].state.target_writable, false);
      if (condition === "foreign") assert.equal(f.calls[0].state.old_memory, undefined);
      assert.equal(f.candidates()[0].decision_note, "operation_target_unavailable");
      assert.equal(f.memory("old")?.status, "active");
    });
  }
});

test("target edits during inference and a failed settlement both roll back the approved operation", async (t) => {
  const f = operationFixture(t);
  f.target();
  const meeting = "The lab now meets on Thursday.";
  insertLine(f.sqlite, "line", meeting);
  await f.extract([{ ...event("amend", meeting), target_memory_id: "old" }]);
  assert.equal((await f.judge(() => {
    f.sqlite.exec("UPDATE memories SET content='Revised by the owner' WHERE id='old'");
    return actionAnswer("update");
  })).failed, 1);
  assert.equal(f.candidates()[0].status, "pending");
  assert.equal(f.memory("old")?.content, "Revised by the owner");
  f.sqlite.exec("UPDATE memories SET content='The lab meets on Tuesday.' WHERE id='old'");
  f.sqlite.exec(`CREATE TRIGGER fail_review BEFORE UPDATE OF status ON memory_candidates
    WHEN NEW.status='approved' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
  assert.equal((await f.judge(() => actionAnswer("update"))).failed, 1);
  assert.equal(f.memory("old")?.status, "active");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get()?.n, 1);
  assert.equal(f.candidates()[0].decision_note, "operation_write_failed");
  f.sqlite.exec("DROP TRIGGER fail_review");
  assert.equal((await f.judge(() => actionAnswer("update"))).approved, 1);
  assert.equal((await f.judge(() => assert.fail("already approved"))).reason, "no_candidates");
});

test("with Clef off, REST and MCP keep an unfamiliar operation as a new memory without touching its target", async (t) => {
  const f = operationFixture(t);
  f.env.CLEF_AUTO_REVIEW = "off";
  f.target();
  const second = "The telescope arrived on Friday.";
  const third = "The dome needs new paint.";
  insertLine(f.sqlite, "line", talk);
  insertLine(f.sqlite, "line2", second);
  insertLine(f.sqlite, "line3", third);
  await f.extract([{ ...event("capture"), target_memory_id: "old" }]);
  await f.extract([event("capture", second, "line2")]);
  await f.extract([event("capture", third, "line3")]);
  const [withTarget, plain, dropped] = f.candidates().map(row => String(row.id));
  assert.equal((await f.judge(() => assert.fail("review disabled"))).reason, "clef_off");
  assert.equal((await f.api(`/${withTarget}/merge`, "POST")).status, 409);

  const kept = await f.api(`/${withTarget}/approve`, "POST");
  assert.equal(kept.status, 200);
  const body = await kept.json() as { data: { memory_id: string; action: string } };
  assert.equal(body.data.action, "added");
  assert.equal(f.memory(body.data.memory_id)?.content, talk);
  assert.equal(f.memory("old")?.status, "active");
  assert.equal(f.memory("old")?.content, "The lab meets on Tuesday.");
  assert.equal(f.candidates()[0].status, "approved");
  assert.equal(f.candidates()[0].source, "dream_add");
  assert.equal((await f.api(`/${withTarget}/discard`, "POST")).status, 409);

  const pending = (await f.mcp("memory_candidates")).content[0].text;
  assert.match(pending, /"action":\s*"unclassified"/);
  assert.match(pending, /"reported_op":\s*"capture"/);
  const approved = await f.mcp("memory_review", { id: plain, decision: "approve" });
  assert.notEqual(approved.isError, true);
  assert.equal(f.memory(JSON.parse(approved.content[0].text).data.memory_id)?.content, second);
  assert.match((await f.mcp("memory_review", { id: dropped, decision: "discard" })).content[0].text, /discarded/);
  assert.deepEqual(f.candidates().map(row => row.status), ["approved", "approved", "discarded"]);
  assert.equal(f.calls.length, 0);
});

test("discarding while Clef is reviewing blocks its later write", async (t) => {
  const f = operationFixture(t);
  insertLine(f.sqlite, "line", talk);
  await f.extract([event("capture")]);
  const id = f.candidates()[0].id;
  await f.judge(async () => {
    assert.equal((await f.api(`/${id}/discard`, "POST")).status, 200);
    return actionAnswer("add");
  });
  assert.equal(f.candidates()[0].status, "discarded");
  assert.equal(f.candidates()[0].decision_note, "discarded");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get()?.n, 0);
});
