import { strict as assert } from "node:assert";
import { generateKeyPairSync, type KeyObject, timingSafeEqual, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import { ADMIN_HTML } from "../src/api/admin/ui";
import worker from "../src/index";

Object.assign(crypto.subtle, { timingSafeEqual });

const previous = "a".repeat(40);
const latest = "b".repeat(40);
const origin = "https://aelios.test";
const forkPath = "/repos/owner/aelios";
const hook = "https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/00112233445566778899";
const connectPath = "/api/admin/update/connect";
const appId = 621;
const ownerId = 283;
const repoId = 634;
const installationId = 745;
const perms = { contents: "write", checks: "read", workflows: "write" };

test("Workers Builds records the repository of a commit fetched without origin", async () => {
  const sourceModule = "../scripts/workers-build-source.mjs";
  const { workersBuildSource } = await import(sourceModule);
  const worker = "companion";
  const env = { WORKERS_CI: "1", WORKERS_CI_BRANCH: "refs/heads/main", WORKERS_CI_COMMIT_SHA: previous };
  const source = `${previous}\t\t'${previous}' of https://x-access-token:example@github.com/owner/Aelios\n`;
  const otherRevision = `${latest}\t\tbranch 'main' of https://github.com/elsewhere/Aelios\n`;
  assert.deepEqual(workersBuildSource(env, "", worker, [], otherRevision + source), {
    commit: previous, repo: "owner/Aelios", workerName: worker
  });
  assert.equal(workersBuildSource(env, "git@github.com:configured/Aelios.git", worker, [], source).repo, "configured/Aelios");
  assert.equal(workersBuildSource(env, "", worker, [], otherRevision).repo, "");
  const ambiguous = `${source}${previous}\t\tbranch 'main' of https://github.com/elsewhere/Aelios\n`;
  assert.equal(workersBuildSource(env, "", worker, [], ambiguous).repo, "");
  assert.equal(workersBuildSource({ ...env, WORKERS_CI_BRANCH: "refs/heads/preview" }, "", worker, [previous], source).commit, "");
});

function setup(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("migrations/0034_admin_deployment_update.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0035_admin_deployment_github.sql", "utf8"));
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
    forkHead: latest,
    commitsAhead: 1,
    isFork: true,
    ownerType: "User",
    mergeType: "fast-forward",
    syncStatus: 200,
    build: null as { status: string; conclusion?: string; completed_at?: string } | null,
    beforeMerge: async () => {},
    buildsStatus: 200,
    pem: "",
    publicKey: null as KeyObject | null,
    installStatus: 404,
    mintStatus: 201,
    minted: 0
  };
  function validateJwt(authorization: string | null) {
    assert.ok(authorization);
    assert.match(authorization, /^Bearer /);
    const [header, claims, signature] = authorization.slice(7).split(".");
    assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256");
    const jwt = JSON.parse(Buffer.from(claims, "base64url").toString());
    assert.equal(jwt.iss, "Iv1.test-app");
    assert.equal(jwt.exp - jwt.iat, 600);
    assert.ok(mock.publicKey);
    assert.ok(verify("sha256", Buffer.from(`${header}.${claims}`), mock.publicKey, Buffer.from(signature, "base64url")));
  }
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    assert.equal(init?.redirect, "manual");
    if (input === hook) {
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      return Response.json({ success: true, result: { build_uuid: "test-build", branch: "main", worker: "companion" } });
    }
    assert.equal(url.origin, "https://api.github.com");
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app-manifests/github-manifest-code/conversions") {
      assert.equal(init?.method, "POST");
      assert.equal(authorization, null);
      return Response.json({ id: appId, owner: { id: ownerId }, slug: "aelios-update-test", client_id: "Iv1.test-app",
        pem: mock.pem, client_secret: "unused-client-secret", webhook_secret: "unused-webhook-secret" }, { status: 201 });
    }
    if (url.pathname === `${forkPath}/installation`) {
      validateJwt(authorization);
      return Response.json({ id: installationId, app_id: appId, account: { id: ownerId }, permissions: perms },
        { status: mock.installStatus });
    }
    if (url.pathname === `/app/installations/${installationId}/access_tokens`) {
      validateJwt(authorization);
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { repository_ids: [repoId], permissions: perms });
      mock.minted += 1;
      return Response.json({ token: `installation-grant-${mock.minted}` }, { status: mock.mintStatus });
    }
    const usesInstallation = url.pathname.endsWith("/merge-upstream") ||
      url.pathname === `${forkPath}/git/ref/heads/main` || url.pathname.endsWith("/check-runs");
    assert.equal(authorization, env.AELIOS_UPDATE_GITHUB_TOKEN ? "Bearer github-test" :
      usesInstallation ? `Bearer installation-grant-${mock.minted}` : null);
    if (url.pathname === "/repos/Aelios-project/Aelios/git/ref/heads/main") return Response.json({ object: { sha: mock.upstream } });
    if (url.pathname.startsWith(`${forkPath}/compare/`)) return Response.json({ ahead_by: mock.commitsAhead });
    if (url.pathname === forkPath) return Response.json({
      id: repoId, owner: { id: ownerId, type: mock.ownerType }, fork: mock.isFork, parent: { full_name: "Aelios-project/Aelios" }
    });
    if (url.pathname === `${forkPath}/merge-upstream`) {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { branch: "main" });
      await mock.beforeMerge();
      return Response.json({ merge_type: mock.mergeType }, { status: mock.syncStatus });
    }
    if (url.pathname === `${forkPath}/git/ref/heads/main`) return Response.json({ object: { sha: mock.forkHead } });
    if (url.pathname === `${forkPath}/commits/${latest}/check-runs`) {
      const other = { status: "completed", conclusion: "failure", app: { slug: "github-actions" } };
      const builds = mock.build ? [{ ...mock.build, name: "Workers Builds: companion", head_sha: latest,
        app: { slug: "cloudflare-workers-and-pages" }, details_url: "https://dash.cloudflare.com/test/builds" }] : [];
      return Response.json({ check_runs: [other, ...builds] }, { status: mock.buildsStatus });
    }
    throw new Error("unexpected fetch");
  });
  const send = (path: string, options?: RequestInit) =>
    worker.fetch(new Request(origin + path, options), env, { waitUntil() {} } as any);
  const request = async (method = "GET", key = "owner-test") => {
    const res = await send("/api/admin/update", {
      method, headers: { authorization: `Bearer ${key}` }
    });
    return { status: res.status, body: await res.json() as any };
  };
  const connect = (key = "owner-test", site = origin) =>
    send(connectPath, { method: "POST", headers: { authorization: `Bearer ${key}`, origin: site } });
  return { env, mock, calls, sqlite, request, send, connect };
}

test("update routes need the main key and a Workers Builds deployment", async t => {
  const { env, calls, request, connect } = setup(t);
  assert.equal((await request("POST", "debug-test")).status, 401);
  assert.equal((await connect("debug-test")).status, 401);
  assert.equal((await connect("owner-test", "https://other.test")).status, 403);
  delete env.AELIOS_BUILD_COMMIT;
  assert.equal((await request()).body.state, "off");
  assert.equal((await connect()).status, 409);
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

test("an unconnected fork offers GitHub setup only when behind", async t => {
  const { env, mock, request, calls, connect } = setup(t);
  delete env.AELIOS_UPDATE_GITHUB_TOKEN;
  assert.equal((await request()).body.state, "connect");
  assert.equal((await request("POST")).body.state, "connect");
  assert.equal(calls.some(call => call.endsWith("/merge-upstream")), false);
  mock.isFork = false;
  assert.equal((await request()).body.state, "off");
  mock.isFork = true;
  mock.upstream = previous;
  assert.equal((await request()).body.state, "current");
  mock.ownerType = "Organization";
  const result = await connect();
  assert.match((await result.json() as any).url, /^https:\/\/github\.com\/organizations\/owner\/settings\/apps\/new\?state=/);
  env.AELIOS_BUILD_REPO = "Aelios-project/Aelios";
  assert.equal((await request()).body.state, "off");
});

test("one browser-bound GitHub registration supports later updates with fresh fork-scoped tokens", async t => {
  const { env, mock, request, send, connect, calls, sqlite } = setup(t);
  delete env.AELIOS_UPDATE_GITHUB_TOKEN;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  mock.pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  mock.publicKey = publicKey;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);

  const begin = await connect();
  assert.equal(begin.status, 200);
  const data = await begin.json() as { url: string; manifest: string };
  const manifest = JSON.parse(data.manifest);
  assert.equal(manifest.public, false);
  assert.equal(manifest.hook_attributes.active, false);
  assert.deepEqual(manifest.default_permissions, perms);
  const state = new URL(data.url).searchParams.get("state");
  const setCookie = begin.headers.get("set-cookie");
  assert.match(setCookie ?? "", /Secure; HttpOnly; SameSite=Lax/);
  const cookie = setCookie?.split(";")[0] ?? "";
  const registered = new URL(manifest.redirect_url);
  assert.equal(registered.origin, origin);
  registered.searchParams.set("code", "github-manifest-code");
  registered.searchParams.set("state", state ?? "");
  const register = (cookie: string, path = registered.pathname + registered.search) => send(path, { headers: { cookie } });
  const invalid = new URL(registered);
  invalid.searchParams.set("state", "wrong-state");
  assert.match((await register(cookie, invalid.pathname + invalid.search)).headers.get("location") ?? "", /update-github=error/);
  assert.match((await register("")).headers.get("location") ?? "", /update-github=error/);
  assert.equal(calls.some(call => call.endsWith("/conversions")), false);

  const concurrent = await Promise.all([register(cookie), register(cookie)]);
  const redirects = concurrent.map(res => res.headers.get("location")).sort();
  assert.equal(redirects[0], "/admin?update-github=error");
  assert.match(redirects[1] ?? "", /^https:\/\/github\.com\/apps\/aelios-update-test\/installations\/new\?state=/);
  const installState = new URL(redirects[1] ?? "").searchParams.get("state");
  assert.ok(installState);
  assert.match((await register(cookie)).headers.get("location") ?? "", /update-github=error/);
  assert.equal(calls.filter(call => call.endsWith("/conversions")).length, 1);
  assert.equal((await request()).body.state, "connect");
  const installed = new URL(manifest.setup_url);
  installed.searchParams.set("installation_id", "999999");
  const finish = () => send(installed.pathname + installed.search, { headers: { cookie } });
  assert.match((await finish()).headers.get("location") ?? "", /update-github=error/);
  assert.equal(calls.some(call => call.endsWith("/installation")), false);
  installed.searchParams.set("state", installState);
  assert.match((await finish()).headers.get("location") ?? "", /update-github=install/);
  mock.installStatus = 200;
  assert.match((await finish()).headers.get("location") ?? "", /update-github=connected/);
  assert.match((await finish()).headers.get("location") ?? "", /update-github=error/);
  const connection = sqlite.prepare("SELECT app_enc, installation_id, browser_proof FROM admin_deployment_github").get();
  assert.equal(connection?.installation_id, installationId);
  assert.equal(connection?.browser_proof, null);
  assert.match(String(connection?.app_enc), /^v1\./);
  assert.doesNotMatch(String(connection?.app_enc), /PRIVATE KEY|unused-client-secret/);

  now += 30 * 24 * 60 * 60_000;
  assert.equal((await request()).body.state, "available");
  assert.equal(mock.minted, 0);
  assert.equal((await request("POST")).body.target, latest);
  mock.build = { status: "completed", conclusion: "success", completed_at: new Date(now).toISOString() };
  assert.equal((await request()).body.reason, "awaiting_live_commit");
  assert.equal(mock.minted, 1);
  assert.match(String(sqlite.prepare("SELECT github_token_enc FROM admin_deployment_update").get()?.github_token_enc), /^v1\./);
  now += 61 * 60_000;
  env.AELIOS_BUILD_COMMIT = latest;
  assert.equal((await request()).body.state, "current");
  mock.upstream = mock.forkHead = "c".repeat(40);
  assert.equal((await request("POST")).body.target, mock.forkHead);
  assert.equal(mock.minted, 2);
  assert.equal(calls.filter(call => call.endsWith("/conversions")).length, 1);

  env.AELIOS_BUILD_COMMIT = mock.forkHead;
  mock.upstream = mock.forkHead = "d".repeat(40);
  mock.mintStatus = 404;
  mock.installStatus = 404;
  assert.equal((await request("POST")).body.state, "connect");
  assert.equal((await request()).body.state, "connect");
  const retry = await connect();
  assert.match((await retry.json() as { url: string }).url,
    /^https:\/\/github\.com\/apps\/aelios-update-test\/installations\/new\?state=/);
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
  await app.startDeploymentUpdate();
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

test("the header sends the manifest to GitHub and clears the callback marker on return", async () => {
  const script = ADMIN_HTML.match(/<script>\s*(function memoryAdmin\(\)[\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const notices: string[] = [];
  const navigations: string[] = [];
  const field = { name: "", type: "", value: "" };
  const form = {
    action: "", method: "", rel: "", hidden: false,
    append(input: typeof field) { assert.equal(input, field); },
    submit() { navigations.push(this.action); }
  };
  const app = runInNewContext(`${script}\nmemoryAdmin()`, {
    localStorage: { getItem: (key: string) => key === "aelios.admin.apiKey" ? "owner-test" : null },
    URL,
    location: { origin, search: "?update-github=connected", href: `${origin}/admin?update-github=connected` },
    history: { replaceState(_state: null, _title: string, url: string) { navigations.push(url); } },
    document: { createElement: (tag: string) => tag === "form" ? form : field,
      body: { append(node: typeof form) { assert.equal(node, form); } } }
  });
  app.notify = (notice: string) => notices.push(notice);
  app.deploymentUpdateHost = origin;
  app.deploymentUpdate = { state: "connect", repo: "owner/aelios" };
  app.request = async (path: string, init: RequestInit) => {
    assert.equal(path, connectPath);
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer owner-test");
    return { url: "https://github.com/settings/apps/new?state=test-state", manifest: '{"public":false}' };
  };
  assert.equal(app.deploymentUpdateVisible(), true);
  assert.equal(app.deploymentUpdateLabel(), "连接 GitHub");
  await app.startDeploymentUpdate();
  assert.equal(form.method, "POST");
  assert.equal(field.name, "manifest");
  assert.equal(field.value, '{"public":false}');
  app.deploymentGitHubResult();
  assert.deepEqual(navigations, ["https://github.com/settings/apps/new?state=test-state", `${origin}/admin`]);
  assert.deepEqual(notices, ["GitHub 已连接，可以更新了。"]);
});
