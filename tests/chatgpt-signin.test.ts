import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import {
  AUTHORIZE_URL, b64url, buildAuthorizeUrl, hasPlanScope, JWKS_URL, parseCallback, parseInstant, pkceChallenge,
  redactAuthorizeUrl, resetOAuthCaches, REVOKE_URL, TOKEN_URL, verifyIdToken
} from "../src/chatgpt/oauth";
import { claimRefreshLease, ensureConnection, isValidHostId, releaseRefreshLease, seal, unseal } from "../src/chatgpt/store";
import { getAccessGrant, keepChatGptAlive } from "../src/chatgpt/token";

(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);

let sqlite: DatabaseSync;
let env: any;
let ctx: any;
let keys: { privateKey: CryptoKey; jwk: JsonWebKey & { kid: string } };
/** Every request the pretend OpenAI saw, in order. */
let seen: { url: string; form?: Record<string, string>; headers?: Record<string, string>; timed?: boolean }[];
let tokenHandler: (form: Record<string, string>) => Response | Promise<Response>;

/** A lookup the test needs to have found; fails with a clear message instead of a TypeError further down. */
function need<T>(value: T | null | undefined, what = "value"): T {
  assert.ok(value !== null && value !== undefined, `expected ${what} to exist`);
  return value as T;
}

const CLIENT = "oaiapp_test_client";
const enc = new TextEncoder();
const part = (value: unknown) => b64url(enc.encode(JSON.stringify(value)));

async function makeKeys() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "key-1", alg: "RS256", use: "sig" } as JsonWebKey & { kid: string };
  return { privateKey: pair.privateKey, jwk };
}
async function idToken(claims: Record<string, unknown>, kid = "key-1"): Promise<string> {
  const head = part({ alg: "RS256", kid, typ: "JWT" });
  const body = part({ iss: "https://auth.openai.com", aud: CLIENT, sub: "user-1", email: "owner@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

function makeDb() {
  return { prepare(sql: string) {
    const statement = sqlite.prepare(sql); let args: any[] = [];
    const api = { bind(...values: any[]) { args = values; return api; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { const r = statement.run(...args); return { meta: { changes: r.changes } }; } };
    return api;
  } };
}
beforeEach(async () => {
  sqlite?.close(); sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((f: string) => f.endsWith(".sql")).sort()) {
    try { sqlite.exec(readFileSync(`migrations/${file}`, "utf8")); }
    catch (error) { if (!String(error).includes("fts5")) throw error; }
  }
  keys = keys ?? await makeKeys();
  resetOAuthCaches();
  seen = [];
  ctx = { waitUntil() {} };
  env = { DB: makeDb(), CHATBOX_API_KEY: "owner-key", IM_API_KEY: "im-key" };
  tokenHandler = async form => Response.json({ access_token: `access-for-${form.grant_type}`, refresh_token: "refresh-1", id_token: await idToken({ nonce: "?" }),
    token_type: "Bearer", expires_in: 3600, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" });
  globalThis.fetch = async (input: any, init: any) => {
    const url = String(input);
    if (url === JWKS_URL) { seen.push({ url }); return Response.json({ keys: [keys.jwk] }); }
    if (url === TOKEN_URL || url === REVOKE_URL) {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      seen.push({ url, form, timed: init.signal instanceof AbortSignal });
      return url === REVOKE_URL ? new Response(null, { status: 200 }) : tokenHandler(form);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});

function call(path: string, body?: any, headers: any = {}) {
  return worker.fetch(new Request(`https://aelios.test/api/gateway/chatgpt/${path}`, {
    method: body === undefined && path === "status" ? "GET" : "POST",
    headers: { authorization: "Bearer owner-key", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), env, ctx);
}
const row = () => sqlite.prepare("SELECT * FROM chatgpt_connection WHERE id = 1").get() as any;

/** Runs login + callback against the pretend OpenAI and returns what the page would have seen. */
async function signIn(options: { scope?: string; nonce?: (n: string) => string; mode?: "new"; sub?: string; clientInCallback?: string | null;
    refresh?: string } = {}) {
  const started = await (await call("login", options.mode ? { account: "new" } : {})).json() as any;
  const url = new URL(started.authorize_url);
  const state = need(url.searchParams.get("state"), "state");
  const nonce = need(url.searchParams.get("nonce"), "nonce");
  const challenge = need(url.searchParams.get("code_challenge"), "code_challenge");
  tokenHandler = async form => {
    // PKCE: the verifier sent now must hash to the challenge sent at login.
    assert.equal(await pkceChallenge(form.code_verifier), challenge);
    return Response.json({ access_token: "access-1", refresh_token: options.refresh ?? "refresh-1",
      id_token: await idToken({ nonce: options.nonce ? options.nonce(nonce) : nonce, ...(options.sub ? { sub: options.sub, email: `${options.sub}@example.com` } : {}) }),
      token_type: "Bearer", expires_in: 3600,
      scope: options.scope ?? "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" });
  };
  const clientPart = options.clientInCallback === null ? "" : `&client_id=${options.clientInCallback ?? CLIENT}`;
  const callback = `http://127.0.0.1:1455/auth/callback?code=code-1&state=${state}${clientPart}`;
  return { started, url, state, response: await call("callback", { url: callback }), callback };
}

test("pkce challenge matches the RFC 7636 appendix B vector", async () => {
  assert.equal(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("authorize url: first sign-in registers, a returning one names the client and drops the app name", () => {
  const base = { hostId: "urn:uuid:3f1c9a52-7b0e-4d1a-9c55-0a6e2b8d4f10", state: "s", nonce: "n", challenge: "c" };
  const first = new URL(buildAuthorizeUrl({ ...base, clientId: null }));
  assert.equal(`${first.origin}${first.pathname}`, AUTHORIZE_URL);
  assert.equal(first.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(first.searchParams.get("agent_name_hint"), "Aelios");
  assert.equal(first.searchParams.get("ext_agent_host_id"), base.hostId);
  assert.equal(first.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.equal(first.searchParams.get("resource"), "https://api.openai.com/v1");
  assert.equal(first.searchParams.get("code_challenge_method"), "S256");
  assert.equal(first.searchParams.get("response_type"), "code");
  assert.deepEqual(need(first.searchParams.get("scope")).split(" "),
    ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"]);
  assert.equal(first.searchParams.get("id_token_hint"), null);
  const again = new URL(buildAuthorizeUrl({ ...base, clientId: CLIENT, idTokenHint: "hint.jwt.value", loginHint: "me@example.com", reconsent: true }));
  assert.equal(again.searchParams.get("client_id"), CLIENT);
  assert.equal(again.searchParams.get("agent_name_hint"), null);
  assert.equal(again.searchParams.get("id_token_hint"), "hint.jwt.value");
  assert.equal(again.searchParams.get("login_hint"), "me@example.com");
  assert.equal(again.searchParams.get("prompt"), "consent");
  const redacted = redactAuthorizeUrl(again.toString());
  assert.ok(!redacted.includes("hint.jwt.value") && !redacted.includes("me%40example.com") && redacted.includes("client_id="));
});

test("the host id is one of the shapes OpenAI accepts; the first login url carries it", async () => {
  assert.equal(isValidHostId("urn:uuid:3f1c9a52-7b0e-4d1a-9c55-0a6e2b8d4f10"), true);
  assert.equal(isValidHostId("urn:ietf:params:oauth:jwk-thumbprint:sha-256:NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"), true);
  assert.equal(isValidHostId("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"), true);
  for (const bad of ["", "aelios-3f1c9a52-7b0e-4d1a-9c55-0a6e2b8d4f10", "3f1c9a52-7b0e-4d1a-9c55-0a6e2b8d4f10", "urn:uuid:not-a-uuid", "did:web:example.com", "owner@example.com"]) {
    assert.equal(isValidHostId(bad), false, bad || "(empty)");
  }
  const { started } = await signIn();
  assert.equal(new URL(started.authorize_url).searchParams.get("ext_agent_host_id"), row().ext_agent_host_id);
});

test("a host id from the earlier build is replaced while nothing is registered, and kept once a client exists", async () => {
  const legacy = "aelios-c09d0fe5-333b-47a8-b338-f60ea662b4a6";
  await ensureConnection(env);
  sqlite.prepare("UPDATE chatgpt_connection SET ext_agent_host_id = ? WHERE id = 1").run(legacy);
  const login = await (await call("login", {})).json() as any;
  const sent = need(new URL(login.authorize_url).searchParams.get("ext_agent_host_id"), "host id in the login url");
  assert.notEqual(sent, legacy);
  assert.equal(isValidHostId(sent), true);
  assert.equal(row().ext_agent_host_id, sent);
  assert.equal((await ensureConnection(env)).ext_agent_host_id, sent, "once replaced it stays");
  sqlite.prepare("UPDATE chatgpt_connection SET ext_agent_host_id = ?, client_id = ? WHERE id = 1").run(legacy, CLIENT);
  assert.equal((await ensureConnection(env)).ext_agent_host_id, legacy, "a registered id is never swapped under its client");
});

test("callback parsing takes the whole address, a bare query, and errors", () => {
  assert.deepEqual(parseCallback(" http://127.0.0.1:1455/auth/callback?code=c&state=s&scope=a+b&client_id=oaiapp_x "),
    { code: "c", state: "s", scope: "a b", clientId: "oaiapp_x", error: undefined, errorDescription: undefined });
  assert.equal(parseCallback("code=c2&state=s2").code, "c2");
  assert.equal(parseCallback("/auth/callback?code=c3&state=s3").state, "s3");
  const denied = parseCallback("http://127.0.0.1:1455/auth/callback?error=access_denied&error_description=no&state=s");
  assert.equal(denied.error, "access_denied");
  assert.equal(denied.code, undefined);
});

test("instants and scopes", () => {
  assert.equal(parseInstant(1_800_000_000), 1_800_000_000_000);
  assert.equal(parseInstant(1_800_000_000_000), 1_800_000_000_000);
  assert.equal(parseInstant("2026-10-25T00:00:00Z"), Date.parse("2026-10-25T00:00:00Z"));
  assert.equal(parseInstant("nope"), null);
  assert.equal(hasPlanScope("openid chatgpt.tokens.use.direct"), true);
  assert.equal(hasPlanScope("openid chatgpt.tokens.use.direct.extra"), false);
});

test("tokens are sealed with a key from the owner key and stop opening when it changes", async () => {
  const sealed = await seal(env, "refresh-secret");
  assert.ok(!sealed.includes("refresh-secret"));
  assert.equal(await unseal(env, sealed), "refresh-secret");
  assert.equal(await unseal({ ...env, CHATBOX_API_KEY: "another-key" }, sealed), null);
  assert.equal(await unseal(env, "v1.broken"), null);
  assert.equal(await unseal(env, null), null);
});

test("admin endpoints are owner-only", async () => {
  for (const [path, body] of [["status", undefined], ["login", {}], ["logout", {}]] as const) {
    assert.equal((await call(path, body, { authorization: "Bearer im-key" })).status, 401, path);
    assert.equal((await call(path, body, { authorization: "" })).status, 401, path);
  }
});

test("sign in: login url, callback, PKCE exchange with the issued client, sealed tokens, no secrets in status", async () => {
  const { started, url, response } = await signIn();
  assert.equal(started.mode, "register");
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(response.status, 200);
  const exchange = need(need(seen.find(item => item.url === TOKEN_URL), "token call").form, "token form");
  assert.equal(exchange.grant_type, "authorization_code");
  assert.equal(exchange.client_id, CLIENT);
  assert.equal(exchange.resource, "https://api.openai.com/v1");
  assert.equal(exchange.redirect_uri, "http://127.0.0.1:1455/auth/callback");
  assert.equal(exchange.code, "code-1");
  assert.ok(!("client_secret" in exchange));
  const saved = row();
  assert.equal(saved.status, "connected");
  assert.equal(saved.client_id, CLIENT);
  assert.equal(saved.subject, "user-1");
  assert.equal(saved.plan_usage, 1);
  assert.match(saved.ext_agent_host_id, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for (const column of ["access_token_enc", "refresh_token_enc", "id_token_enc"]) {
    assert.ok(saved[column].startsWith("v1."), column);
    assert.ok(!saved[column].includes("access-1") && !saved[column].includes("refresh-1"), column);
  }
  const status = await (await call("status")).text();
  assert.ok(!status.includes("access-1") && !status.includes("refresh-1") && !status.includes(saved.access_token_enc));
  const parsed = JSON.parse(status);
  assert.equal(parsed.status, "connected");
  assert.equal(parsed.email, "owner@example.com");
  assert.equal(parsed.welcome, true);
  await call("welcome", {});
  assert.equal((await (await call("status")).json() as any).welcome, false);
});

test("a second sign-in of the same account reuses the client and host id and sends the hint, not the app name", async () => {
  await signIn();
  const hostId = row().ext_agent_host_id;
  const again = await (await call("login", { reconsent: true })).json() as any;
  const url = new URL(again.authorize_url);
  assert.equal(again.mode, "reauth");
  assert.equal(url.searchParams.get("client_id"), CLIENT);
  assert.equal(url.searchParams.get("ext_agent_host_id"), hostId);
  assert.equal(url.searchParams.get("agent_name_hint"), null);
  assert.ok(url.searchParams.get("id_token_hint"));
  assert.equal(url.searchParams.get("login_hint"), "owner@example.com");
  assert.equal(url.searchParams.get("prompt"), "consent");
  const fresh = new URL((await (await call("login", { account: "new" })).json() as any).authorize_url);
  assert.equal(fresh.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(fresh.searchParams.get("id_token_hint"), null);
});

test("sign in refuses a replayed address, a wrong state, a declined consent and a forged nonce", async () => {
  const done = await signIn();
  assert.equal(done.response.status, 200);
  const replay = await call("callback", { url: done.callback });
  assert.equal(replay.status, 400);
  assert.match((await replay.json() as any).error, /unknown or has expired/);

  const wrongState = await call("callback", { url: `http://127.0.0.1:1455/auth/callback?code=x&state=nope&client_id=${CLIENT}` });
  assert.equal(wrongState.status, 400);

  const second = await (await call("login", {})).json() as any;
  const state = need(new URL(second.authorize_url).searchParams.get("state"), "state");
  const denied = await call("callback", { url: `http://127.0.0.1:1455/auth/callback?error=access_denied&state=${state}` });
  assert.equal(denied.status, 400);
  assert.match((await denied.json() as any).error, /declined/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM chatgpt_login_pending WHERE state = ?").get(state)?.n, 0);

  const stored = row().access_token_enc;
  const forged = await signIn({ nonce: () => "some-other-nonce" });
  assert.equal(forged.response.status, 502, "an ID token that fails validation is ChatGPT's answer being wrong, not the pasted address");
  assert.match((await forged.response.json() as any).error, /nonce/);
  assert.equal(row().access_token_enc, stored, "a forged sign-in must leave the stored session alone");
});

test("an ID token signed by anyone else, or for another client, is rejected", async () => {
  const good = await idToken({ nonce: "n1" });
  assert.equal((await verifyIdToken(good, { clientId: CLIENT, nonce: "n1" })).sub, "user-1");
  const other = await makeKeys();
  const real = keys;
  keys = { ...other, jwk: { ...real.jwk } };   // signs with a key the JWKS does not hold
  const forged = await idToken({ nonce: "n1" });
  keys = real;
  await assert.rejects(verifyIdToken(forged, { clientId: CLIENT, nonce: "n1" }), /signature/);
  await assert.rejects(verifyIdToken(await idToken({ aud: "oaiapp_other" }), { clientId: CLIENT }), /different client/);
  await assert.rejects(verifyIdToken(await idToken({ iss: "https://evil.example" }), { clientId: CLIENT }), /issuer/);
  await assert.rejects(verifyIdToken(await idToken({ exp: Math.floor(Date.now() / 1000) - 7200 }), { clientId: CLIENT }), /expired/);
  await assert.rejects(verifyIdToken(await idToken({}, "unknown-kid"), { clientId: CLIENT }), /unknown/);
});

test("signed in without the plan scope: kept, marked plan_disabled, and no token is handed out", async () => {
  const { response } = await signIn({ scope: "openid profile email offline_access resource.invoke" });
  assert.equal(response.status, 200);
  assert.equal(row().status, "plan_disabled");
  assert.equal(row().plan_usage, 0);
  await assert.rejects(getAccessGrant(env), (error: any) => error.kind === "plan_disabled" && error.status === 403);
});

/** Puts the stored session where a test needs it. */
async function age(options: { expiresIn: number; refreshedAgo?: number; earliest?: number | null }) {
  await signIn();
  sqlite.prepare("UPDATE chatgpt_connection SET access_expires_at = ?, refreshed_at = ?, earliest_refresh_at = ?, access_token_enc = ? WHERE id = 1")
    .run(Date.now() + options.expiresIn, Date.now() - (options.refreshedAgo ?? 0), options.earliest ?? null, await seal(env, "access-old"));
  seen = [];
}
const refreshCalls = () => seen.filter(item => item.url === TOKEN_URL && item.form?.grant_type === "refresh_token");

test("a fresh token is used as is; a stale one is refreshed with the issued client, no scope, and the rotation is kept", async () => {
  await age({ expiresIn: 3600_000 });
  assert.equal((await getAccessGrant(env)).accessToken, "access-old");
  assert.equal(refreshCalls().length, 0);

  sqlite.prepare("UPDATE chatgpt_connection SET access_expires_at = ?").run(Date.now() + 60_000);
  tokenHandler = async form => {
    assert.equal(form.client_id, CLIENT);
    assert.equal(form.refresh_token, "refresh-1");
    assert.equal(form.resource, "https://api.openai.com/v1");
    assert.ok(!("scope" in form), "scope must be omitted to keep the grant");
    return Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600,
      scope: "openid offline_access chatgpt.tokens.use.direct", earliest_refresh_at: Math.floor(Date.now() / 1000) + 1800 });
  };
  const grant = await getAccessGrant(env);
  assert.deepEqual(grant, { accessToken: "access-2", clientId: CLIENT });
  assert.equal(await unseal(env, row().refresh_token_enc), "refresh-2");
  assert.equal(row().status, "connected");
  assert.ok(row().earliest_refresh_at > Date.now());
  assert.equal(row().refresh_lease_until, null);
});

test("a token that still works is not refreshed before the time ChatGPT named", async () => {
  await age({ expiresIn: 120_000, earliest: Date.now() + 600_000 });
  assert.equal((await getAccessGrant(env)).accessToken, "access-old");
  assert.equal(refreshCalls().length, 0);
});

test("two requests racing on a dead token refresh once; both get the new token", async () => {
  await age({ expiresIn: -1000 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  tokenHandler = async () => {
    await gate;
    return Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
  };
  const both = Promise.all([getAccessGrant(env, { pollMs: 5 }), getAccessGrant(env, { pollMs: 5 })]);
  setTimeout(release, 40);
  const [a, b] = await both;
  assert.equal(a.accessToken, "access-2");
  assert.equal(b.accessToken, "access-2");
  assert.equal(refreshCalls().length, 1);
});

test("while someone else refreshes, a token with time left is used instead of waiting", async () => {
  await age({ expiresIn: 120_000 });
  sqlite.prepare("UPDATE chatgpt_connection SET refresh_lease_until = ?").run(Date.now() + 20_000);
  assert.equal((await getAccessGrant(env)).accessToken, "access-old");
  assert.equal(refreshCalls().length, 0);
});

test("a dead refresh token clears the session and asks for a new sign-in; the registration stays", async () => {
  for (const code of ["invalid_grant", "refresh_token_reused", "refresh_token_expired"]) {
    await age({ expiresIn: -1000 });
    tokenHandler = () => Response.json({ error: code }, { status: 400 });
    await assert.rejects(getAccessGrant(env), (error: any) => error.kind === "needs_login");
    const saved = row();
    assert.equal(saved.status, "needs_login", code);
    assert.equal(saved.refresh_token_enc, null);
    assert.equal(saved.access_token_enc, null);
    assert.equal(saved.client_id, CLIENT);
    assert.ok(saved.ext_agent_host_id);
    await assert.rejects(getAccessGrant(env), (error: any) => error.kind === "needs_login");
    sqlite.exec("DELETE FROM chatgpt_connection");
    resetOAuthCaches();
  }
});

test("a refresh that fails for any other reason keeps the sign-in and serves the old token while it lasts", async () => {
  await age({ expiresIn: 60_000 });
  tokenHandler = () => new Response("bad gateway", { status: 502 });
  assert.equal((await getAccessGrant(env)).accessToken, "access-old");
  assert.equal(row().status, "connected");
  assert.ok(row().refresh_token_enc);
  assert.match(row().last_error, /refresh failed/);
  sqlite.prepare("UPDATE chatgpt_connection SET access_expires_at = ?").run(Date.now() - 1000);
  await assert.rejects(getAccessGrant(env), (error: any) => error.kind === "unavailable" && error.status === 503);
  assert.equal(row().status, "connected");
  assert.equal(row().refresh_lease_until, null);
  globalThis.fetch = async () => { throw new TypeError("network down"); };
  await assert.rejects(getAccessGrant(env), (error: any) => error.kind === "unavailable");
  assert.equal(row().status, "connected");
});

test("a stored sign-in that no longer opens is reported as sign in again, and nothing is erased over it", async () => {
  await age({ expiresIn: 3600_000 });
  const rotated = { ...env, CHATBOX_API_KEY: "rotated-key", DEBUG_API_KEY: "debug-key" };
  await assert.rejects(getAccessGrant(rotated), (error: any) => error.kind === "needs_login");
  assert.equal(row().status, "connected", "the cause may be a secret that is briefly wrong; the grant is kept");
  assert.ok(row().refresh_token_enc && row().access_token_enc);
  // The status page tells the truth while the key is wrong...
  const status = await (await worker.fetch(new Request("https://aelios.test/api/gateway/chatgpt/status", { headers: { authorization: "Bearer debug-key" } }), rotated, ctx)).json() as any;
  assert.equal(status.status, "needs_login");
  assert.equal(status.connected, false);
  // ...and the right key opens it again, unharmed.
  assert.equal((await getAccessGrant(env)).accessToken, "access-old");
  // A missing key is not a verdict on the session at all.
  await assert.rejects(getAccessGrant({ ...env, CHATBOX_API_KEY: undefined }), (error: any) => error.kind === "unavailable");
  assert.equal(row().status, "connected");
});

test("forced refresh (after a 401) skips a token that was refreshed a moment ago", async () => {
  await age({ expiresIn: 3600_000, refreshedAgo: 5_000 });
  assert.equal((await getAccessGrant(env, { force: true })).accessToken, "access-old");
  assert.equal(refreshCalls().length, 0);
  sqlite.prepare("UPDATE chatgpt_connection SET refreshed_at = ?").run(Date.now() - 600_000);
  tokenHandler = () => Response.json({ access_token: "access-3", refresh_token: "refresh-3", expires_in: 3600 });
  assert.equal((await getAccessGrant(env, { force: true })).accessToken, "access-3");
  assert.equal(refreshCalls().length, 1);
});

test("nightly keep-alive refreshes a sign-in idle for a week and leaves a recent one alone", async () => {
  await age({ expiresIn: 3600_000, refreshedAgo: 86_400_000 });
  assert.equal(await keepChatGptAlive(env), "skipped");
  assert.equal(refreshCalls().length, 0);
  sqlite.prepare("UPDATE chatgpt_connection SET refreshed_at = ?").run(Date.now() - 8 * 86_400_000);
  tokenHandler = () => Response.json({ access_token: "access-9", refresh_token: "refresh-9", expires_in: 3600 });
  assert.equal(await keepChatGptAlive(env), "refreshed");
  assert.equal(refreshCalls().length, 1);
  assert.equal(await unseal(env, row().refresh_token_enc), "refresh-9");
  assert.equal(await keepChatGptAlive(env), "skipped");
  sqlite.exec("DELETE FROM chatgpt_connection");
  assert.equal(await keepChatGptAlive(env), "skipped");
});

test("sign out revokes the refresh token, clears the tokens and keeps the registration for next time", async () => {
  await signIn();
  seen = [];
  const out = await (await call("logout", {})).json() as any;
  assert.equal(out.ok, true);
  assert.equal(out.revoked, true);
  const revoke = need(need(seen.find(item => item.url === REVOKE_URL), "revoke call").form, "revoke form");
  assert.deepEqual(revoke, { token: "refresh-1", token_type_hint: "refresh_token", client_id: CLIENT });
  const saved = row();
  assert.equal(saved.status, "disconnected");
  assert.equal(saved.refresh_token_enc, null);
  assert.equal(saved.client_id, CLIENT);
  assert.ok(saved.ext_agent_host_id);
  await assert.rejects(getAccessGrant(env), (error: any) => error.kind === "not_connected");
});

test("switching to a different account revokes the old refresh token", async () => {
  await signIn();
  seen = [];
  tokenHandler = async () => Response.json({});
  const { response } = await signIn({ mode: "new" });
  assert.equal(response.status, 200);
  // Same client id and subject in this fake, so nothing to revoke; a changed subject must revoke.
  assert.equal(seen.filter(item => item.url === REVOKE_URL).length, 0);
  const started = await (await call("login", { account: "new" })).json() as any;
  const url = new URL(started.authorize_url);
  const nonce = need(url.searchParams.get("nonce"), "nonce");
  tokenHandler = async () => Response.json({ access_token: "access-b", refresh_token: "refresh-b",
    id_token: await idToken({ nonce, sub: "user-2", email: "other@example.com" }), expires_in: 3600,
    scope: "openid offline_access chatgpt.tokens.use.direct" });
  const done = await call("callback", { url: `http://127.0.0.1:1455/auth/callback?code=c&state=${url.searchParams.get("state")}&client_id=${CLIENT}` });
  assert.equal(done.status, 200);
  assert.deepEqual(seen.filter(item => item.url === REVOKE_URL).map(item => item.form?.token), ["refresh-1"]);
  assert.equal(row().subject, "user-2");
  assert.equal(row().welcomed, 0);
});

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("a refresh that was in flight while the owner signed in again cannot wipe the new session; the request is served from it", async () => {
  await age({ expiresIn: -1000 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  tokenHandler = async () => { await gate; return Response.json({ error: "invalid_grant" }, { status: 400 }); };
  const inflight = getAccessGrant(env, { pollMs: 5 });
  await pause(30);                                   // the refresh is out, holding the lease
  await signIn({ refresh: "refresh-new" });          // meanwhile the owner signs in again
  release();
  const grant = await inflight;
  assert.equal(grant.accessToken, "access-1");
  assert.equal(row().status, "connected");
  assert.equal(await unseal(env, row().refresh_token_enc), "refresh-new");
});

test("a refresh that succeeds after the owner switched accounts leaves the new account alone and hands its own token back", async () => {
  await age({ expiresIn: -1000 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  tokenHandler = async () => { await gate; return Response.json({ access_token: "access-old-account", refresh_token: "refresh-rotated-old", expires_in: 3600 }); };
  const inflight = getAccessGrant(env, { pollMs: 5 });
  await pause(30);
  await signIn({ mode: "new", sub: "user-2", refresh: "refresh-user-2" });
  release();
  const grant = await inflight;
  assert.equal(row().subject, "user-2");
  assert.equal(await unseal(env, row().refresh_token_enc), "refresh-user-2");
  assert.equal(grant.accessToken, "access-1");
  assert.ok(seen.filter(item => item.url === REVOKE_URL).map(item => item.form?.token).includes("refresh-rotated-old"));
});

test("only the holder of the refresh lease can put it back", async () => {
  await signIn();
  const first = await claimRefreshLease(env, Date.now(), 1000);
  assert.ok(first);
  assert.equal(await claimRefreshLease(env, Date.now(), 1000), null);
  const second = await claimRefreshLease(env, Date.now() + 5000, 1000);   // the first lease lapsed; someone took over
  assert.ok(second && second !== first);
  await releaseRefreshLease(env, need(first));                            // the old holder finishes late
  assert.equal(row().refresh_lease_owner, second);
  assert.ok(row().refresh_lease_until);
  await releaseRefreshLease(env, need(second));
  assert.equal(row().refresh_lease_until, null);
  assert.equal(row().refresh_lease_owner, null);
});

test("the token call has a timeout, and a refresh is handed to waitUntil so a client hanging up cannot lose the new token", async () => {
  await age({ expiresIn: 3600_000 });
  const handed: Promise<unknown>[] = [];
  await getAccessGrant(env, { waitUntil: promise => handed.push(promise) });
  assert.equal(handed.length, 0, "a fresh token needs no refresh");
  sqlite.prepare("UPDATE chatgpt_connection SET access_expires_at = ?").run(Date.now() + 60_000);
  tokenHandler = () => Response.json({ access_token: "a2", refresh_token: "r2", expires_in: 3600 });
  await getAccessGrant(env, { waitUntil: promise => handed.push(promise) });
  assert.equal(handed.length, 1);
  assert.equal(refreshCalls()[0].timed, true, "the refresh call carries an abort signal");
  await Promise.all(handed);
  assert.equal(row().refresh_lease_until, null);
});

test("after a refresh fails for a reason that may pass, ChatGPT is not asked again on every request", async () => {
  await age({ expiresIn: 120_000 });
  tokenHandler = () => new Response("down", { status: 503 });
  for (let i = 0; i < 20; i++) assert.equal((await getAccessGrant(env)).accessToken, "access-old");
  assert.equal(refreshCalls().length, 1);
  assert.ok(row().refresh_retry_at > Date.now());
  sqlite.prepare("UPDATE chatgpt_connection SET refresh_retry_at = ?").run(Date.now() - 1);
  await getAccessGrant(env);
  assert.equal(refreshCalls().length, 2, "once the pause is over it tries again");
  sqlite.prepare("UPDATE chatgpt_connection SET access_expires_at = ?, refresh_retry_at = ?").run(Date.now() - 1000, Date.now() + 20_000);
  await assert.rejects(getAccessGrant(env), (error: any) => error.kind === "unavailable");
  assert.equal(refreshCalls().length, 2, "with nothing to serve it fails fast instead of asking again");
  sqlite.prepare("UPDATE chatgpt_connection SET refresh_retry_at = ?").run(Date.now() - 1);
  tokenHandler = () => Response.json({ access_token: "a3", refresh_token: "r3", expires_in: 3600 });
  assert.equal((await getAccessGrant(env)).accessToken, "a3");
  assert.equal(row().refresh_retry_at, null);
});

test("the nightly keep-alive also renews a signed-in account that was never granted plan usage", async () => {
  await signIn({ scope: "openid profile email offline_access resource.invoke" });
  assert.equal(row().status, "plan_disabled");
  sqlite.prepare("UPDATE chatgpt_connection SET refreshed_at = ?").run(Date.now() - 8 * 86_400_000);
  seen = [];
  tokenHandler = () => Response.json({ access_token: "ak", refresh_token: "rk", expires_in: 3600, scope: "openid offline_access" });
  assert.equal(await keepChatGptAlive(env), "refreshed");
  assert.equal(refreshCalls().length, 1);
  assert.equal(row().status, "plan_disabled");
  assert.equal(await unseal(env, row().refresh_token_enc), "rk");
});

test("signing in again as a different account is refused and its tokens handed back; switching accounts is the way to replace it", async () => {
  await signIn();
  seen = [];
  const again = await signIn({ sub: "user-2", refresh: "refresh-other" });
  assert.equal(again.started.mode, "reauth");
  assert.equal(again.response.status, 400);
  assert.match(((await again.response.json()) as any).error, /different ChatGPT account/);
  assert.equal(row().subject, "user-1");
  assert.equal(await unseal(env, row().refresh_token_enc), "refresh-1");
  assert.deepEqual(seen.filter(item => item.url === REVOKE_URL).map(item => item.form?.token), ["refresh-other"]);
  // The page can offer the switch for a saved registration whatever state the session is in.
  const status = await (await call("status")).json() as any;
  assert.equal(status.registered, true);
  await call("logout", {});
  assert.equal((await (await call("status")).json() as any).registered, true);
});

test("a callback naming the registration entry point, or no client at all, is not accepted as a new client", async () => {
  const entry = await signIn({ clientInCallback: "dynamic_agent_client" });
  assert.equal(entry.response.status, 502);
  assert.equal(row().client_id, null);
  assert.equal(row().status, "disconnected");
  const none = await signIn({ clientInCallback: null });
  assert.equal(none.response.status, 502);
  assert.equal((await (await call("status")).json() as any).registered, false);
});

test("a failure reaching ChatGPT during sign-in is reported as that, not as a missing migration", async () => {
  const started = await (await call("login", {})).json() as any;
  const state = need(new URL(started.authorize_url).searchParams.get("state"), "state");
  tokenHandler = () => { throw new TypeError("network down"); };
  const reply = await call("callback", { url: `http://127.0.0.1:1455/auth/callback?code=c&state=${state}&client_id=${CLIENT}` });
  assert.equal(reply.status, 502);
  const message = (await reply.json() as any).error;
  assert.match(message, /Could not finish the ChatGPT sign-in/);
  assert.doesNotMatch(message, /migration/i);
  assert.equal(row().status, "disconnected");
});

test("an ID token with a malformed signature is an invalid ID token, not a crash", async () => {
  const [head, body] = (await idToken({ nonce: "n" })).split(".");
  await assert.rejects(verifyIdToken(`${head}.${body}.***`, { clientId: CLIENT, nonce: "n" }), (error: any) => error.code === "invalid_id_token");
});

test("a refresh whose save landed but reported an error does not revoke the token it just stored", async () => {
  await age({ expiresIn: -1000 });
  tokenHandler = () => Response.json({ access_token: "access-renewed", refresh_token: "refresh-renewed", expires_in: 3600 });
  const real = env.DB;
  let failed = false;
  env.DB = { prepare(sql: string) {
    const statement = real.prepare(sql);
    if (!sql.includes("SET access_token_enc = ?,")) return statement;       // the refresh's own save
    const wrapper = { bind(...values: any[]) { statement.bind(...values); return wrapper; },
      async run() {
        const result = await statement.run();
        if (!failed) { failed = true; throw new Error("D1 network error after the commit"); }
        return result;
      } };
    return wrapper;
  } };
  seen = [];
  const grant = await getAccessGrant(env);
  assert.equal(grant.accessToken, "access-renewed");
  assert.equal(await unseal(env, row().refresh_token_enc), "refresh-renewed");
  assert.equal(seen.filter(item => item.url === REVOKE_URL).length, 0, "the token now stored must not be revoked");
});
