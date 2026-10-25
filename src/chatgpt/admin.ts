// Owner-only endpoints behind the ChatGPT card in /admin:
//   GET  /api/gateway/chatgpt/status     what is connected and whether plan usage was granted
//   POST /api/gateway/chatgpt/login      { account?: "new", reconsent?: true } -> the address to open
//   POST /api/gateway/chatgpt/callback   { url } the address the browser could not load -> sign-in finished
//   POST /api/gateway/chatgpt/test       { model? } one real, tiny request, plus the model list
//   POST /api/gateway/chatgpt/welcome    the one-time "You're using your ChatGPT plan" notice was shown
//   POST /api/gateway/chatgpt/logout     revoke at ChatGPT and clear the tokens
// Tokens are never returned; the page only ever learns the state.
import { ownerOnly } from "../gateway/admin";
import type { Body } from "../gateway/protocol";
import type { Env } from "../types";
import { readJsonObject } from "../utils/request";
import { listChatGptModels, MODEL_PREFIX, postResponses, resetModelCache, type WaitUntil } from "./client";
import { ChatGptApiError, describeFailure, readFailure } from "./errors";
import { chatCompletionFromResponse, collectResponse } from "./fromResponses";
import {
  buildAuthorizeUrl, exchangeCode, hasPlanScope, OAuthError, parseCallback, parseInstant, pkceChallenge, randomToken,
  REDIRECT_URI, REGISTER_CLIENT_ID, revokeToken, verifyIdToken
} from "./oauth";
import { SseReader } from "./sse";
import {
  clearSession, createPending, ensureConnection, loadConnection, markWelcomed, saveSession, takePending, unseal,
  type ConnectionRow
} from "./store";
import { ChatGptAuthError } from "./token";

const reply = (body: Body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const refuse = (message: string, status = 400) => reply({ error: message }, status);

export function statusPayload(row: ConnectionRow | null): Body {
  const iso = (ms: number | null | undefined) => ms ? new Date(ms).toISOString() : null;
  return {
    status: row?.status ?? "disconnected",
    connected: row?.status === "connected",
    plan_usage: Boolean(row?.plan_usage),
    email: row?.email ?? null,
    access_expires_at: iso(row?.access_expires_at),
    refreshed_at: iso(row?.refreshed_at),
    last_error: row?.last_error ?? null,
    // The first time plan usage is on, the page greets once; the flag lives here so every browser agrees.
    welcome: row?.status === "connected" && !row.welcomed,
    // A saved registration can be reused (same account) or replaced (another account); the page offers the second.
    registered: Boolean(row?.client_id),
    redirect_uri: REDIRECT_URI,
    model_prefix: MODEL_PREFIX
  };
}
/** Tokens that no longer open (the owner key changed) are as good as gone, so they are not reported as connected. */
async function currentStatus(env: Env): Promise<Body> {
  const row = await loadConnection(env);
  const payload = statusPayload(row);
  if (row?.refresh_token_enc && ["connected", "plan_disabled"].includes(row.status) && await unseal(env, row.refresh_token_enc) === null) {
    return { ...payload, status: "needs_login", connected: false, welcome: false,
      last_error: "The stored sign-in can no longer be read (the owner key changed?). Sign in again." };
  }
  return payload;
}

async function login(env: Env, request: Request): Promise<Response> {
  const body = await readJsonObject(request) ?? {};
  const row = await ensureConnection(env);
  // A different ChatGPT account is a different registration; the same account reuses its client and skips the picker.
  const register = body.account === "new" || !row.client_id;
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(32);
  await createPending(env, { state, verifier, nonce, redirect_uri: REDIRECT_URI, mode: register ? "register" : "reauth" });
  const url = buildAuthorizeUrl({
    clientId: register ? null : row.client_id, hostId: row.ext_agent_host_id, state, nonce, challenge: await pkceChallenge(verifier),
    idTokenHint: register ? null : await unseal(env, row.id_token_enc), loginHint: register ? null : row.email,
    reconsent: body.reconsent === true
  });
  return reply({ authorize_url: url, expires_in: 600, mode: register ? "register" : "reauth", redirect_uri: REDIRECT_URI });
}

async function callback(env: Env, request: Request): Promise<Response> {
  const body = await readJsonObject(request) ?? {};
  const pasted = typeof body.url === "string" ? body.url : typeof body.code === "string" && typeof body.state === "string"
    ? `code=${encodeURIComponent(body.code)}&state=${encodeURIComponent(body.state)}` : "";
  if (!pasted.trim()) return refuse("Paste the address the browser ended on (it starts with http://127.0.0.1).");
  const params = parseCallback(pasted);
  if (params.error) {
    if (params.state) await takePending(env, params.state);
    return refuse(params.error === "access_denied" ? "ChatGPT sign-in was declined, so nothing was connected."
      : `ChatGPT sign-in failed (${params.error}${params.errorDescription ? `: ${params.errorDescription}` : ""}).`);
  }
  if (!params.state || !params.code) return refuse("That address has no sign-in code. Copy the whole address from the browser's address bar.");
  const pending = await takePending(env, params.state);
  if (!pending) return refuse("This sign-in attempt is unknown or has expired. Start again from \"Continue with ChatGPT\".");
  const row = await ensureConnection(env);
  let clientId: string;
  if (pending.mode === "register") {
    // The entry-point id only starts a registration; it is never the id of a session.
    if (!params.clientId || params.clientId === REGISTER_CLIENT_ID) return refuse("ChatGPT did not issue a client for this sign-in. Start again.", 502);
    clientId = params.clientId;
  } else {
    if (!row.client_id) return refuse("There is no saved ChatGPT registration to sign in again with. Start again.");
    if (params.clientId && params.clientId !== row.client_id) return refuse("ChatGPT answered for a different client than the saved one, so it was rejected.");
    clientId = row.client_id;
  }
  try {
    const tokens = await exchangeCode({ clientId, code: params.code, verifier: pending.verifier, redirectUri: pending.redirect_uri });
    if (!tokens.id_token) return refuse("ChatGPT did not return an ID token.", 502);
    if (!tokens.refresh_token) return refuse("ChatGPT did not return a refresh token, so the sign-in could not be kept.", 502);
    const claims = await verifyIdToken(tokens.id_token, { clientId, nonce: pending.nonce });
    // Signing in again must be the same account: replacing the saved one is "use another account", which asks for it.
    if (pending.mode === "reauth" && row.subject && claims.sub !== row.subject) {
      await revokeToken({ clientId, refreshToken: tokens.refresh_token });
      return refuse("That was a different ChatGPT account from the one saved here, so nothing was changed. To switch accounts, use \"Use another ChatGPT account\".");
    }
    const scopes = typeof tokens.scope === "string" ? tokens.scope : params.scope || "";
    // A different account or registration replaces the old one; its refresh token is revoked on the way out.
    if (row.refresh_token_enc && row.client_id && (row.client_id !== clientId || row.subject !== claims.sub)) {
      const old = await unseal(env, row.refresh_token_enc);
      if (old) await revokeToken({ clientId: row.client_id, refreshToken: old });
    }
    await saveSession(env, {
      clientId, subject: claims.sub, email: claims.email ?? null, scopes, planUsage: hasPlanScope(scopes),
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token,
      expiresAt: Date.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000,
      earliestRefreshAt: parseInstant(tokens.earliest_refresh_at)
    });
    resetModelCache();
  } catch (error) {
    if (error instanceof OAuthError) {
      console.error("chatgpt sign-in failed", { code: error.code, status: error.status });
      return refuse(error.code === "invalid_grant"
        ? "That sign-in code was already used or has expired. Start again from \"Continue with ChatGPT\"."
        : `ChatGPT sign-in failed (${error.code}${error.message ? `: ${error.message}` : ""}).`, error.status >= 500 ? 502 : 400);
    }
    // Not an answer from ChatGPT: it could not be reached, or what came back could not be checked. The code in the
    // address is spent either way, so a fresh attempt is the way on.
    console.error("chatgpt sign-in failed", { error: error instanceof Error ? error.name : "unknown" });
    return refuse(`Could not finish the ChatGPT sign-in (${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}). Start again from "Continue with ChatGPT".`, 502);
  }
  return reply({ ok: true, ...await currentStatus(env) });
}

/** The page must be able to tell "I could not reach ChatGPT" from "ChatGPT said no", and show the reason. */
function failureReport(step: string, error: unknown): Body {
  if (error instanceof ChatGptAuthError) return { ok: false, step: "sign-in", kind: error.kind, error: error.message };
  if (error instanceof ChatGptApiError) {
    const described = describeFailure(error.failure);
    return { ok: false, step, status: error.failure.status, code: described.code, error: described.message };
  }
  return { ok: false, step, error: `Could not reach ChatGPT (${error instanceof Error ? error.message : "network"}).` };
}
async function test(env: Env, request: Request, waitUntil?: WaitUntil): Promise<Response> {
  const body = await readJsonObject(request) ?? {};
  const started = Date.now();
  try {
    const models = await listChatGptModels(env, { fresh: true, waitUntil });
    const asked = typeof body.model === "string" ? body.model.trim() : "";
    const model = asked ? (asked.startsWith(MODEL_PREFIX) ? asked.slice(MODEL_PREFIX.length) : asked) : models[0]?.slug;
    if (!model) return reply({ ok: false, step: "models", error: "ChatGPT listed no models for this account." });
    const response = await postResponses(env, {
      model, instructions: "Reply with the single word OK.", input: [{ role: "user", content: "ping" }], store: false, stream: true
    }, undefined, waitUntil);
    if (!response.ok || !response.body) throw new ChatGptApiError(await readFailure(response));
    const reader = new SseReader(response.body);
    const collected = await collectResponse(reader, response.headers.get("x-request-id"));
    await reader.cancel();
    if (collected.failure) throw new ChatGptApiError(collected.failure);
    const answer = collected.response ? chatCompletionFromResponse(collected.response, model).choices[0].message.content : "";
    return reply({ ok: true, model, latency_ms: Date.now() - started, reply: String(answer ?? "").slice(0, 80),
      models: models.map(item => ({ slug: item.slug, name: item.name })) });
  } catch (error) {
    return reply(failureReport("request", error));
  }
}

async function logout(env: Env): Promise<Response> {
  const row = await loadConnection(env);
  let revoked: boolean | null = null;
  if (row?.refresh_token_enc && row.client_id) {
    const token = await unseal(env, row.refresh_token_enc);
    if (token) {
      revoked = await revokeToken({ clientId: row.client_id, refreshToken: token });
      if (!revoked) revoked = await revokeToken({ clientId: row.client_id, refreshToken: token });
    }
  }
  // Tokens go either way; the registration stays so signing in again is the same client on the same host.
  if (row) await clearSession(env, "disconnected", null);
  resetModelCache();
  return reply({ ok: true, revoked, ...await currentStatus(env) });
}

export async function handleChatGptAdmin(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!await ownerOnly(request, env)) return reply({ error: "Owner key required" }, 401);
  const action = new URL(request.url).pathname.replace(/^\/api\/gateway\/chatgpt\/?/, "");
  const method = request.method;
  try {
    if (action === "status" && method === "GET") return reply(await currentStatus(env));
    if (method !== "POST" || !["login", "callback", "test", "welcome", "logout"].includes(action)) {
      return reply({ error: "Unknown ChatGPT endpoint" }, action === "status" || !action ? 405 : 404);
    }
    if (action === "login") return await login(env, request);
    if (action === "callback") return await callback(env, request);
    if (action === "test") return await test(env, request, ctx ? promise => ctx.waitUntil(promise) : undefined);
    if (action === "logout") return await logout(env);
    await ensureConnection(env);
    await markWelcomed(env);
    return reply({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("chatgpt admin failed", { action, error: message });
    // Only a missing table says "migrations"; any other failure is reported as what it is.
    return reply({ error: /no such (table|column)|sign-in store is unavailable/i.test(message)
      ? "ChatGPT sign-in store unavailable. Apply the D1 migrations first."
      : `ChatGPT sign-in failed unexpectedly (${message.slice(0, 160)}).` }, 503);
  }
}
