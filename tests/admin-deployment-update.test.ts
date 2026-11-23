import { strict as assert } from "node:assert";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import { ADMIN_HTML } from "../src/api/admin/ui";
import worker from "../src/index";

Object.assign(crypto.subtle, { timingSafeEqual });

const previous = "a".repeat(40);
const latest = "b".repeat(40);
const forkPath = "/repos/owner/aelios";
const hook = "https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/00112233445566778899";

function setup(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("migrations/0034_admin_deployment_update.sql", "utf8"));
  t.after(() => sqlite.close());
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...values: SQLInputValue[]) {
          return {
            async first() { return statement.get(...values) ?? null; },
            async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; }
          };
        }
      };
    }
  };
  const env: any = { DB: db, CHATBOX_API_KEY: "owner-test", DEBUG_API_KEY: "debug-test",
    AELIOS_BUILD_COMMIT: previous, AELIOS_BUILD_REPO: "owner/aelios", AELIOS_BUILD_WORKER: "companion",
    AELIOS_UPDATE_GITHUB_TOKEN: "github-test", AELIOS_UPDATE_DEPLOY_HOOK: hook };
  const calls: string[] = [];
  const mock = {
    upstream: latest,
    commitsAhead: 1,
    isFork: true,
    mergeType: "fast-forward",
    syncStatus: 200,
    build: null as { status: string; conclusion?: string; completed_at?: string } | null,
    beforeMerge: async () => {},
    buildsStatus: 200
  };
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (input === hook) {
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      return Response.json({ success: true, result: { build_uuid: "test-build", branch: "main", worker: "companion" } });
    }
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer github-test");
    if (url.pathname === "/repos/Aelios-project/Aelios/git/ref/heads/main") return Response.json({ object: { sha: mock.upstream } });
    if (url.pathname.startsWith(`${forkPath}/compare/`)) return Response.json({ ahead_by: mock.commitsAhead });
    if (url.pathname === forkPath) return Response.json({ fork: mock.isFork, parent: { full_name: "Aelios-project/Aelios" } });
    if (url.pathname === `${forkPath}/merge-upstream`) {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { branch: "main" });
      await mock.beforeMerge();
      return Response.json({ merge_type: mock.mergeType }, { status: mock.syncStatus });
    }
    if (url.pathname === `${forkPath}/git/ref/heads/main`) return Response.json({ object: { sha: latest } });
    if (url.pathname === `${forkPath}/commits/${latest}/check-runs`) {
      const other = { status: "completed", conclusion: "failure", app: { slug: "github-actions" } };
      const builds = mock.build ? [{ ...mock.build, name: "Workers Builds: companion", head_sha: latest,
        app: { slug: "cloudflare-workers-and-pages" }, details_url: "https://dash.cloudflare.com/test/builds" }] : [];
      return Response.json({ check_runs: [other, ...builds] }, { status: mock.buildsStatus });
    }
    throw new Error("unexpected fetch");
  });
  const request = async (method = "GET", key = "owner-test") => {
    const res = await worker.fetch(new Request("https://aelios.test/api/admin/update", {
      method, headers: { authorization: `Bearer ${key}` }
    }), env, { waitUntil() {} } as any);
    return { status: res.status, body: await res.json() as any };
  };
  return { env, mock, calls, request };
}

test("update route needs the main key and a Workers Builds deployment configured for updates", async t => {
  const { env, calls, request } = setup(t);
  assert.equal((await request("POST", "debug-test")).status, 401);
  delete env.AELIOS_UPDATE_GITHUB_TOKEN;
  assert.equal((await request()).body.state, "off");
  assert.deepEqual(calls, []);
});

test("update availability uses the commit relation, including forks with custom commits", async t => {
  const { env, mock, request } = setup(t);
  env.AELIOS_UPDATE_REPO = "other/fallback";
  assert.equal((await request()).body.state, "available");
  mock.commitsAhead = 0;
  assert.equal((await request()).body.state, "current");
  mock.upstream = previous;
  mock.commitsAhead = 1;
  assert.equal((await request()).body.state, "current");
});

test("one sync is claimed across concurrent clicks and only a running commit confirms the update", { timeout: 5_000 }, async t => {
  const { env, mock, calls, request } = setup(t);
  let entered!: () => void;
  const inMerge = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const letMergeFinish = new Promise<void>(resolve => { release = resolve; });
  mock.beforeMerge = async () => { entered(); await letMergeFinish; };
  const first = request("POST");
  await inMerge;
  try {
    assert.equal((await request("POST")).body.state, "starting");
  } finally {
    release();
  }
  assert.equal((await first).body.target, latest);
  assert.equal(calls.filter(call => call.endsWith("/merge-upstream")).length, 1);
  assert.equal(calls.some(call => call.includes("/deploy_hooks/")), false);
  mock.build = { status: "completed", conclusion: "success", completed_at: new Date().toISOString() };
  const deploying = (await request()).body;
  assert.equal(deploying.state, "deploying");
  assert.equal(deploying.reason, "awaiting_live_commit");
  env.AELIOS_BUILD_COMMIT = latest;
  assert.equal((await request()).body.state, "current");
});

test("an already synced fork reuses a running build and retries a failed build through its Deploy Hook", async t => {
  const { mock, request, calls } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  mock.mergeType = "none";
  mock.build = { status: "in_progress" };
  assert.equal((await request("POST")).body.state, "deploying");
  assert.equal(calls.some(call => call.includes("/deploy_hooks/")), false);

  now += 10_000;
  mock.build = { status: "completed", conclusion: "failure", completed_at: new Date(now - 500).toISOString() };
  assert.equal((await request()).body.reason, "build_failed");
  // The retry now sees the previously failed check as historical.
  assert.equal((await request("POST")).body.state, "deploying");
  assert.equal(calls.filter(call => call.includes("/deploy_hooks/")).length, 1);
  assert.equal((await request()).body.state, "deploying");
  assert.equal((await request("POST")).body.state, "deploying");
  assert.equal(calls.filter(call => call.includes("/deploy_hooks/")).length, 1);
});

test("the updater rejects unrelated repos and a sync conflict does not deploy", async t => {
  const { mock, request, calls } = setup(t);
  mock.isFork = false;
  assert.equal((await request("POST")).body.reason, "fork_required");
  assert.equal(calls.some(call => call.endsWith("/merge-upstream")), false);
  mock.isFork = true;
  mock.syncStatus = 409;
  assert.equal((await request("POST")).body.reason, "merge_conflict");
  mock.syncStatus = 422;
  assert.equal((await request("POST")).body.reason, "sync_rejected");
  assert.equal(calls.some(call => call.includes("/deploy_hooks/")), false);
});

test("a missing Checks permission cannot start an unverified retry", async t => {
  const { mock, request, calls } = setup(t);
  mock.mergeType = "none";
  mock.buildsStatus = 403;
  assert.equal((await request("POST")).body.reason, "github_permission");
  assert.equal(calls.some(call => call.includes("/deploy_hooks/")), false);
});

test("the header offers an update only when needed and polls until the Worker reports up to date", async () => {
  const script = ADMIN_HTML.match(/<script>\s*(function memoryAdmin\(\)[\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const storage = new Map([["aelios.admin.apiKey", "owner-test"]]);
  const timers = new Map<number, () => Promise<void>>();
  const app = runInNewContext(`${script}\nmemoryAdmin()`, {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null },
    location: { origin: "https://aelios.test" },
    window: { setTimeout(next: () => Promise<void>) { timers.set(1, next); return 1; }, clearTimeout(id: number) { timers.delete(id); } }
  });
  app.notify = () => {};
  const states = [{ state: "current" }, { state: "available" }, { state: "deploying" },
    { state: "deploying", reason: "awaiting_live_commit" }, { state: "current" }];
  const methods: string[] = [];
  app.request = async (path: string, init: RequestInit) => {
    assert.equal(path, "/api/admin/update");
    methods.push(init.method ?? "GET");
    return states.shift();
  };
  assert.equal(app.deploymentUpdateVisible(), false);
  await app.loadDeploymentUpdate();
  assert.equal(app.deploymentUpdateVisible(), false);
  assert.equal(timers.size, 0);
  await app.loadDeploymentUpdate();
  assert.equal(app.deploymentUpdateVisible(), true);
  await app.loadDeploymentUpdate(true);
  assert.equal(app.deploymentUpdateBusy(), true);
  assert.equal(app.deploymentUpdateLabel(), "更新中");
  const nextPoll = timers.get(1);
  assert.ok(nextPoll);
  await nextPoll();
  assert.equal(app.deploymentUpdateLabel(), "发布中");
  const finalPoll = timers.get(1);
  assert.ok(finalPoll);
  await finalPoll();
  assert.equal(app.deploymentUpdateVisible(), false);
  assert.equal(timers.size, 0);
  assert.deepEqual(methods, ["GET", "GET", "POST", "GET", "GET"]);
});
