import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runDailyMemoryDigest } from "../src/memory/dream/orchestrator";
import { claimRollingWindow } from "../src/memory/rolling/inbox";
import { runRollingWindow } from "../src/memory/rolling/runner";
import { getRollingDreamStatus } from "../src/memory/rolling/stats";
import type { Env, OpenAIChatRequest } from "../src/types";
import { insertLine, NOVEL, SYNTHETIC_DAY } from "./support/rolling-fixture";
import { sqliteFixture } from "./support/sqlite";

const GEMINI = "google-vertex-ai/google/gemini-3.8-flash";
const triage = { async classify() { return NOVEL; } };

function geminiEnv(db: D1Database, respond: (query: OpenAIChatRequest) => Response): Env {
  return {
    DB: db, DREAM_MODEL: GEMINI, ROLLING_WINDOW_MESSAGES: "1", DREAM_TIME_ZONE: "UTC",
    AI: {
      gateway: () => ({
        async run({ query }: { query: OpenAIChatRequest }) { return respond(query); }
      })
    } as unknown as Env["AI"]
  };
}

function modelResponse(op: string, content = "The lab got a new telescope.") {
  return Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ events: [{
      op, type: "event", content, attributed_role: "user",
      evidence_ids: ["telescope"], evidence_quote: "The lab got a new telescope."
    }], state_delta: {} })
  } }] });
}

test("Gemini's observed add operation creates a grounded candidate and reports a separate write count", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  insertLine(sqlite, "telescope", "The lab got a new telescope.");
  let calls = 0;
  const env = geminiEnv(db, (query) => {
    calls += 1;
    assert.equal(query.model, GEMINI);
    assert.match(String(query.messages[1].content), /new, continuation, update, no_op/);
    return modelResponse("add");
  });
  assert.equal((await runRollingWindow(env, "default", { triage })).extracted, true);
  assert.equal(calls, 1);
  assert.equal(sqlite.prepare("SELECT content FROM memory_candidates").get()?.content, "The lab got a new telescope.");
  const { recent_windows: [window] } = await getRollingDreamStatus(env, "default");
  assert.deepEqual(window.writes, { candidates: 1, memories: 0, revisions: 0 });
  assert.equal(window.model, GEMINI);
  assert.equal(window.message_count, 1);
});

test("Gemini can send a new operation name without another daytime inference", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  insertLine(sqlite, "telescope", "The lab got a new telescope.");
  let calls = 0;
  const env = geminiEnv(db, () => { calls += 1; return modelResponse("carry_forward"); });
  assert.equal((await runRollingWindow(env, "default", { triage })).extracted, true);
  assert.equal(calls, 1);
  const row = sqlite.prepare("SELECT source, provenance, status FROM memory_candidates").get();
  assert.equal(row?.source, "dream_unclassified");
  assert.equal(row?.status, "pending");
  assert.equal(JSON.parse(String(row?.provenance)).proposed_operation.reported_op, "carry_forward");
});

test("an unsupported operation without a usable candidate leaves the chat to nightly Dream", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  insertLine(sqlite, "telescope", "The lab got a new telescope.");
  let calls = 0;
  const env = geminiEnv(db, () => { calls += 1; return modelResponse("delete", ""); });
  const failure = await runRollingWindow(env, "default", { triage });
  assert.equal(failure.reason, "extractor_invalid_operation");
  assert.equal(failure.retryAfter, undefined);
  assert.equal((await runRollingWindow(env, "default", { triage })).reason, "no_window");
  assert.equal(calls, 1);
  const [window] = (await getRollingDreamStatus(env, "default")).failed_windows;
  assert.equal(window.disposition, "nightly");
  assert.equal(window.failure?.phase, "extraction");
  assert.equal(window.writes, undefined);
  assert.equal(sqlite.prepare("SELECT done_at FROM rolling_inbox").get()?.done_at, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_candidates").get()?.count, 0);

  const seen: string[] = [];
  const nightly: Env = { ...env, DREAM_MODEL: "workers-ai/@cf/zai-org/glm-4.7-flash",
    AI: { async run(_model: string, input: OpenAIChatRequest) {
      const [system, body] = input.messages ?? [];
      if (!system) return { data: [[1, 0]] };
      if (String(system.content).includes("no reasoning")) return { response: { title: "Lab", summary: "The telescope arrived." } };
      seen.push(String(body.content));
      return { response: { memories: [] } };
    } } as unknown as Env["AI"]
  };
  const run = () => runDailyMemoryDigest(nightly, "default", { dateLabel: SYNTHETIC_DAY });
  assert.equal((await run()).ran, true);
  const next = await run();
  assert.equal(next.ran ? undefined : next.reason, "already_done");
  assert.equal(seen.length, 1);
  assert.match(seen[0], /The lab got a new telescope/);
});

test("a transient model rejection shows its HTTP status until retry succeeds", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  insertLine(sqlite, "telescope", "The lab got a new telescope.");
  let calls = 0;
  const env = geminiEnv(db, () => {
    calls += 1;
    return calls === 1 ? new Response("synthetic upstream error text", { status: 429 }) : modelResponse("new");
  });
  const attempt = await runRollingWindow(env, "default", { triage });
  assert.equal(attempt.retryAfter, 2);
  const { current_window: pending, active_window: active } = await getRollingDreamStatus(env, "default");
  assert.equal(active, null);
  assert.equal(pending?.state, "retrying");
  assert.equal(pending?.phase, "extraction");
  assert.equal(pending?.last_failure?.http_status, 429);
  assert.doesNotMatch(JSON.stringify(pending), /synthetic upstream error text/);
  await runRollingWindow(env, "default", { triage });
  const status = await getRollingDreamStatus(env, "default");
  assert.equal(status.current_window, null);
  assert.equal(status.recent_windows[0].clef_calls, 1);
  assert.equal(status.recent_windows[0].extractor_calls, 2);
  assert.equal(status.recent_windows[0].writes?.candidates, 1);
});

test("an expired lease remains visible even when the legacy active field is empty", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = { DB: db, ROLLING_WINDOW_MESSAGES: "1" };
  insertLine(sqlite, "telescope", "The lab got a new telescope.");
  assert.ok((await claimRollingWindow(env, "default")).claim);
  assert.equal((await getRollingDreamStatus(env, "default")).current_window?.state, "running");
  sqlite.exec("UPDATE rolling_inbox SET claimed_at='2000-01-01T00:00:00.000Z'");
  const status = await getRollingDreamStatus(env, "default", { includeBacklog: false });
  assert.equal(status.active_window, null);
  assert.equal(status.current_window?.state, "stalled");
  assert.equal(status.current_window?.phase, "triage");
  assert.equal("backlog" in status, false);
});

test("a hung Clef request hits a deadline and leaves a specific failure reason", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  insertLine(sqlite, "telescope", "The lab got a new telescope.");
  let started = (_: AbortSignal | undefined) => {};
  const enteredTriage = new Promise<AbortSignal | undefined>((resolve) => { started = resolve; });
  const pending = runRollingWindow({ DB: db, ROLLING_WINDOW_MESSAGES: "1", ROLLING_MAX_ATTEMPTS: "1" }, "default", {
    triage: { async classify(_packet, signal) {
      started(signal);
      return await new Promise(() => {});
    } }
  });
  const signal = await enteredTriage;
  assert.ok(signal);
  t.mock.timers.tick(30_000);
  assert.equal((await pending).reason, "triage_timeout");
  assert.equal(signal.aborted, true);
  assert.equal((await getRollingDreamStatus({ DB: db }, "default")).failed_windows[0].disposition, "nightly");
});

test("0030 reopens legacy pre-write failures and preserves ambiguous write failures", (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const migration = "0030_rolling_failure_recovery.sql";
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql") && name < migration).sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  for (const [window, error] of [["rolling_legacy", "extraction_failed"], ["rolling_partial", "window_processing_failed"]]) {
    insertLine(sqlite, window, "Kept transcript.");
    sqlite.prepare("UPDATE rolling_inbox SET window_key=?, done_at='2026-11-17T10:00:00.000Z', error=? WHERE message_id=?")
      .run(window, error, window);
    sqlite.prepare("INSERT INTO memory_events(id,event_type,payload_json,created_at) VALUES (?,'rolling_window',?,'2026-11-17T10:00:00.000Z')")
      .run(window, JSON.stringify({ window_key: window, status: "failed", error }));
  }
  sqlite.exec(readFileSync(`migrations/${migration}`, "utf8"));
  const inspect = sqlite.prepare("SELECT done_at,rolling_skipped,window_key FROM rolling_inbox WHERE message_id=?");
  assert.equal(inspect.get("rolling_legacy")?.done_at, null);
  assert.equal(inspect.get("rolling_legacy")?.window_key, null);
  assert.equal(inspect.get("rolling_legacy")?.rolling_skipped, 1);
  assert.equal(inspect.get("rolling_partial")?.window_key, "rolling_partial");
  assert.ok(inspect.get("rolling_partial")?.done_at);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_events").get()?.count, 2);
});
