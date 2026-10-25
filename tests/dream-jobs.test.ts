import { strict as assert } from "node:assert";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { handleDreamResolve, handleDreamRun, handleDreamStatus } from "../src/api/dream";
import {
  claimQueuedDreamRun,
  describeDreamRun,
  DREAM_RUN_STALE_MS,
  finishDreamRun,
  insertQueuedDreamRun,
  type DreamRunRow
} from "../src/db/dreamRuns";
import { runDreamJob } from "../src/memory/dream/jobs";
import { handleQueueMessage } from "../src/queue/consumer";
import type { DreamRunQueueMessage, Env } from "../src/types";

// Synthetic local SQLite only; all pipeline invocations below are disabled or injected.
(crypto.subtle as any).timingSafeEqual = timingSafeEqual;
let sqlite: DatabaseSync;
let env: Env;
let sent: DreamRunQueueMessage[];

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
    try { sqlite.exec(readFileSync(`migrations/${file}`, "utf8")); }
    catch (error) { if (!String(error).includes("fts5")) throw error; }
  }
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let args: any[] = [];
      const api = {
        bind(...values: any[]) { args = values; return api; },
        async first() { return statement.get(...args) ?? null; },
        async all() { return { results: statement.all(...args) }; },
        async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; }
      };
      return api;
    }
  };
  sent = [];
  env = {
    DB: db as unknown as D1Database,
    CHATBOX_API_KEY: "synthetic-owner",
    ENABLE_DREAM: "false",
    DREAM_TIME_ZONE: "UTC",
    MEMORY_QUEUE: { async send(message: DreamRunQueueMessage) { sent.push(message); } } as any
  };
});
afterEach(() => sqlite.close());

function request(body: Record<string, unknown>) {
  return new Request("https://synthetic.test/v1/dream/run", {
    method: "POST", headers: { authorization: "Bearer synthetic-owner", "content-type": "application/json" },
    body: JSON.stringify({ namespace: "test-space", date: "2026-01-10", ...body })
  });
}
const row = (id: string) => sqlite.prepare("SELECT * FROM dream_runs WHERE id = ?").get(id) as unknown as DreamRunRow;
async function queued() {
  const runId = await insertQueuedDreamRun(env.DB, { namespace: "test-space", dateLabel: "2026-01-10" });
  assert.ok(runId);
  return { type: "dream_run", runId, namespace: "test-space", dateLabel: "2026-01-10", force: false } satisfies DreamRunQueueMessage;
}

test("background acceptance persists queued before sending, awaits send, and returns the 202 contract", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = () => {};
  const sending = new Promise<void>((resolve) => { entered = resolve; });
  env.MEMORY_QUEUE = { async send(message: DreamRunQueueMessage) {
    assert.equal(row(message.runId).status, "queued");
    sent.push(message); entered(); await gate;
  } } as any;
  let returned = false;
  const pending = handleDreamRun(request({ background: true, force: true }), env).then((response) => {
    returned = true; return response;
  });
  await sending;
  assert.equal(returned, false);
  release();
  const response = await pending;
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { data: {
    namespace: "test-space", date: "2026-01-10", force: true, dry_run: false,
    run_id: sent[0].runId, status: "queued"
  } });
  assert.deepEqual(sent[0], {
    type: "dream_run", namespace: "test-space", dateLabel: "2026-01-10", force: true, runId: sent[0].runId
  });
});

test("missing queue is explicit 503 without persisting a pretend background job", async () => {
  delete env.MEMORY_QUEUE;
  assert.equal((await handleDreamRun(request({ background: true }), env)).status, 503);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM dream_runs").get()?.n, 0);
});

test("enqueue rejection marks only a still-queued job as error", async () => {
  env.MEMORY_QUEUE = { async send(message: DreamRunQueueMessage) {
    sent.push(message); throw new Error("synthetic rejection");
  } } as any;
  const response = await handleDreamRun(request({ background: true }), env);
  assert.equal(response.status, 503);
  const run = row(sent[0].runId);
  assert.equal(run.status, "error");
  assert.equal(run.reason, "enqueue_failed");
  assert.ok(run.finished_at);
});

test("enqueue cleanup DB failure preserves the unresolved lock and still returns 503 with a run ID", async () => {
  const db = env.DB;
  env.MEMORY_QUEUE = { async send(message: DreamRunQueueMessage) {
    sent.push(message);
    env.DB = { prepare(sql: string) {
      if (sql.includes("SET status = 'error'")) throw new Error("synthetic cleanup DB failure");
      return db.prepare(sql);
    } } as D1Database;
    throw new Error("synthetic queue failure");
  } } as any;
  const response = await handleDreamRun(request({ background: true }), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json() as any).data.run_id, sent[0].runId);
  assert.equal(row(sent[0].runId).status, "queued");
  env.DB = db;
  assert.equal((await handleDreamRun(request({ background: true, force: true }), env)).status, 409);
});

test("an ambiguous send failure cannot mark an already claimed task as error", async () => {
  env.MEMORY_QUEUE = { async send(message: DreamRunQueueMessage) {
    sent.push(message);
    assert.equal(await claimQueuedDreamRun(env.DB, message), true);
    throw new Error("synthetic lost acceptance response");
  } } as any;
  assert.equal((await handleDreamRun(request({ background: true }), env)).status, 503);
  assert.equal(row(sent[0].runId).status, "running");
  assert.equal(row(sent[0].runId).finished_at, null);
});

test("atomic admission blocks concurrent same-namespace clicks, even force on another date", async () => {
  const results = await Promise.all([
    handleDreamRun(request({ background: true }), env),
    handleDreamRun(request({ background: true, force: true, date: "2026-01-11" }), env)
  ]);
  assert.deepEqual(results.map((response) => response.status).sort(), [202, 409]);
  assert.equal(sent.length, 1);
  const conflict = await results.find((response) => response.status === 409)?.json() as any;
  assert.equal(conflict.data.active_run.id, sent[0].runId);
  assert.equal((await handleDreamRun(request({ background: true, namespace: "other-space" }), env)).status, 202);
});

test("background dry-run and legacy requests remain synchronous and never enqueue", async () => {
  delete env.MEMORY_QUEUE;
  for (const body of [{ background: true, dry_run: true }, {}, { background: "true" }]) {
    const response = await handleDreamRun(request(body), env);
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.data.result.reason, "dream_disabled");
    assert.equal(payload.data.run_id, undefined);
  }
  assert.equal(sent.length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM dream_runs").get()?.n, 0);
});

test("background rejects invalid dates before persisting or enqueueing", async () => {
  for (const date of ["bad-date", "2026-02-30"]) {
    assert.equal((await handleDreamRun(request({ background: true, date }), env)).status, 400);
  }
  assert.equal(sent.length, 0);
});

test("claim executes once with the original run ID, including concurrent/running and completed redelivery", async () => {
  const job = await queued();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const pipeline: Parameters<typeof runDreamJob>[2] = async (_env, namespace, options) => {
    calls += 1;
    assert.equal(namespace, job.namespace);
    assert.deepEqual(options, { dateLabel: job.dateLabel, force: false, trigger: "manual", runId: job.runId });
    assert.equal(row(job.runId).status, "running");
    entered(); await gate;
    await finishDreamRun(env.DB, { id: job.runId, status: "ok" });
    return { ran: false, mode: "dream", reason: "no_messages" };
  };
  const first = runDreamJob(env, job, pipeline);
  await started;
  await Promise.all([runDreamJob(env, job, pipeline), runDreamJob(env, job, pipeline)]);
  assert.equal(calls, 1);
  release(); await first;
  await runDreamJob(env, job, pipeline);
  assert.equal(calls, 1);
  assert.equal(row(job.runId).status, "ok");
});

test("unknown or mismatched jobs cannot claim; crashes are not automatically replayed", async () => {
  const job = await queued();
  let calls = 0;
  const pipeline: Parameters<typeof runDreamJob>[2] = async () => { calls += 1; throw new Error("synthetic"); };
  await runDreamJob(env, { ...job, runId: "missing" }, pipeline);
  await runDreamJob(env, { ...job, namespace: "wrong" }, pipeline);
  await runDreamJob(env, { ...job, dateLabel: "2026-01-11" }, pipeline);
  assert.equal(calls, 0);
  await claimQueuedDreamRun(env.DB, job); // Simulated abrupt runtime cancellation after claim.
  await runDreamJob(env, job, pipeline);
  assert.equal(calls, 0);
  assert.equal(row(job.runId).status, "running");
});

test("claim DB failure is retriable before pipeline invocation", async () => {
  const job = await queued();
  const db = env.DB;
  let calls = 0;
  const pipeline: Parameters<typeof runDreamJob>[2] = async () => {
    calls += 1;
    await finishDreamRun(env.DB, { id: job.runId, status: "skipped", reason: "no_messages" });
    return { ran: false, mode: "dream", reason: "no_messages" };
  };
  env.DB = { prepare() { throw new Error("synthetic claim unavailable"); } } as unknown as D1Database;
  await assert.rejects(runDreamJob(env, job, pipeline), /claim unavailable/);
  assert.equal(calls, 0);
  assert.equal(row(job.runId).status, "queued");
  env.DB = db;
  await runDreamJob(env, job, pipeline);
  assert.equal(calls, 1);
  assert.equal(row(job.runId).status, "skipped");
});

test("failed exception finalization leaves an unresolved claim but redelivery still cannot replay", async () => {
  const job = await queued();
  const db = env.DB;
  let calls = 0;
  env.DB = { prepare(sql: string) {
    if (sql.includes("SET status = 'error'")) throw new Error("synthetic finalization unavailable");
    return db.prepare(sql);
  } } as D1Database;
  const pipeline: Parameters<typeof runDreamJob>[2] = async () => { calls += 1; throw new Error("synthetic pipeline failure"); };
  await assert.rejects(runDreamJob(env, job, pipeline), /finalization unavailable/);
  assert.equal(row(job.runId).status, "running");
  env.DB = db;
  await runDreamJob(env, job, pipeline);
  assert.equal(calls, 1);
});

test("pipeline exceptions close unresolved runs, never execute on redelivery or overwrite terminal status", async () => {
  const job = await queued();
  let calls = 0;
  await runDreamJob(env, job, async () => { calls += 1; throw new Error("synthetic provider error"); });
  assert.equal(row(job.runId).status, "error");
  assert.equal(row(job.runId).reason, "execution_failed");
  await runDreamJob(env, job, async () => { calls += 1; throw new Error("must not run"); });
  assert.equal(calls, 1);
  const next = await queued();
  await runDreamJob(env, next, async () => {
    await finishDreamRun(env.DB, { id: next.runId, status: "error", reason: "specific_failure" });
    throw new Error("after finalization");
  });
  assert.equal(row(next.runId).reason, "specific_failure");
});

test("real consumer reuses the accepted run for disabled and no-message skips without a second run row", async () => {
  for (const enabled of ["false", "true"]) {
    env.ENABLE_DREAM = enabled;
    const response = await handleDreamRun(request({ background: true }), env);
    assert.equal(response.status, 202);
    const job = sent[sent.length - 1];
    const before = Number(sqlite.prepare("SELECT COUNT(*) AS n FROM dream_runs").get()?.n);
    await handleQueueMessage(job, env);
    const run = row(job.runId);
    assert.equal(run.status, "skipped");
    assert.equal(run.reason, enabled === "true" ? "no_messages" : "dream_disabled");
    assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM dream_runs").get()?.n), before);
    await handleQueueMessage(job, env);
    assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM dream_runs").get()?.n), before);
  }
});

test("stale status is read-only, includes unresolved tasks older than history, and still blocks force", async () => {
  const job = await queued();
  sqlite.prepare("UPDATE dream_runs SET status = 'running', started_at = ? WHERE id = ?")
    .run("2020-01-01T00:00:00.000Z", job.runId);
  const before = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
  const response = await handleDreamStatus(new Request("https://synthetic.test/v1/dream/status?namespace=test-space", {
    headers: { authorization: "Bearer synthetic-owner" }
  }), env);
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.data.dream_runs.length, 0);
  assert.equal(payload.data.active_run.id, job.runId);
  assert.equal(payload.data.active_run.status, "running");
  assert.equal(payload.data.active_run.stale, true);
  assert.match(payload.data.active_run.warning, /unconfirmed/);
  assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, before);
  assert.equal(row(job.runId).status, "running");
  assert.equal((await handleDreamRun(request({ background: true, force: true }), env)).status, 409);
});

test("stale threshold is 20 minutes and never marks terminal jobs stale", async () => {
  const job = await queued();
  const run = row(job.runId);
  const start = Date.parse(run.started_at);
  assert.equal(describeDreamRun(run, start + DREAM_RUN_STALE_MS - 1).stale, false);
  assert.equal(describeDreamRun(run, start + DREAM_RUN_STALE_MS).stale, true);
  assert.equal(describeDreamRun({ ...run, status: "ok" }, start + DREAM_RUN_STALE_MS).stale, false);
});

function resolveRequest(body: Record<string, unknown>, authorized = true) {
  return new Request("https://synthetic.test/v1/dream/resolve", {
    method: "POST",
    headers: { ...(authorized ? { authorization: "Bearer synthetic-owner" } : {}), "content-type": "application/json" },
    body: JSON.stringify({ namespace: "test-space", ...body })
  });
}

test("an operator can close a stale task, which releases admission and keeps a late delivery from replaying", async () => {
  const job = await queued();
  sqlite.prepare("UPDATE dream_runs SET status = 'running', started_at = ? WHERE id = ?")
    .run("2020-01-01T00:00:00.000Z", job.runId);
  assert.equal((await handleDreamRun(request({ background: true }), env)).status, 409);

  const response = await handleDreamResolve(resolveRequest({ run_id: job.runId }), env);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as any).data, {
    namespace: "test-space", run_id: job.runId, status: "error", reason: "marked_interrupted"
  });
  const closed = row(job.runId);
  assert.equal(closed.status, "error");
  assert.equal(closed.reason, "marked_interrupted");
  assert.ok(closed.finished_at);
  assert.match(closed.error ?? "", /earlier writes may already exist/);

  assert.equal((await handleDreamRun(request({ background: true }), env)).status, 202);

  let calls = 0;
  await runDreamJob(env, job, async () => { calls += 1; throw new Error("must not run"); });
  assert.equal(calls, 0);
});

test("closing is refused for a task that may still be running, a finished one, an unknown id or another space", async () => {
  const job = await queued();
  const fresh = await handleDreamResolve(resolveRequest({ run_id: job.runId }), env);
  assert.equal(fresh.status, 409);
  const payload = await fresh.json() as any;
  assert.equal(payload.data.run.id, job.runId);
  assert.equal(payload.data.run.stale, false);
  assert.equal(row(job.runId).status, "queued");

  // Terminal rows are never rewritten, however old.
  sqlite.prepare("UPDATE dream_runs SET status = 'ok', started_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", job.runId);
  assert.equal((await handleDreamResolve(resolveRequest({ run_id: job.runId }), env)).status, 409);
  assert.equal(row(job.runId).status, "ok");

  assert.equal((await handleDreamResolve(resolveRequest({ run_id: "drm_missing" }), env)).status, 404);
  assert.equal((await handleDreamResolve(resolveRequest({ run_id: job.runId, namespace: "other-space" }), env)).status, 404);
  assert.equal((await handleDreamResolve(resolveRequest({}), env)).status, 400);
  assert.equal((await handleDreamResolve(resolveRequest({ run_id: job.runId }, false), env)).status, 401);
});

test("the last batch of a date writes its diary after the dream, and a failing diary does not undo the dream", async () => {
  const job = await queued();
  const calls: Array<[string, string]> = [];
  const finished: Parameters<typeof runDreamJob>[2] = async () => {
    await finishDreamRun(env.DB, { id: job.runId, status: "ok", processedMessages: 3 });
    return { ran: true } as never;
  };
  await runDreamJob(env, job, finished, (async (_env: Env, namespace: string, date: string) => {
    calls.push([namespace, date]);
    throw new Error("synthetic diary failure");
  }) as never);
  assert.deepEqual(calls, [["test-space", "2026-01-10"]]);
  assert.equal(row(job.runId).status, "ok");

  const skipped = await queued();
  await runDreamJob(env, skipped, async () => {
    await finishDreamRun(env.DB, { id: skipped.runId, status: "skipped", reason: "already_done" });
    return { ran: false, mode: "dream", reason: "already_done" };
  }, (async () => { calls.push(["unexpected", "call"]); }) as never);
  assert.equal(calls.length, 1);
});
