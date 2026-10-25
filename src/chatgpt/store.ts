import type { Env } from "../types";
import { nowIso } from "../utils/time";
import { b64url, fromB64url, hasPlanScope } from "./oauth";

export type ConnectionStatus = "disconnected" | "connected" | "plan_disabled" | "needs_login";

export interface ConnectionRow {
  id: number;
  ext_agent_host_id: string;
  client_id: string | null;
  subject: string | null;
  email: string | null;
  scopes: string;
  plan_usage: number;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  id_token_enc: string | null;
  access_expires_at: number | null;
  earliest_refresh_at: number | null;
  refreshed_at: number | null;
  refresh_lease_until: number | null;
  refresh_lease_owner: string | null;
  refresh_retry_at: number | null;
  status: ConnectionStatus;
  last_error: string | null;
  welcomed: number;
  created_at: string;
  updated_at: string;
}

const PENDING_TTL_MS = 10 * 60_000;

// Tokens never sit in D1 as plain text. The key is derived from the owner key, so there is nothing new to
// configure; rotate that key and the stored tokens stop opening, which reads as "sign in again", not a fault.
async function sealKey(env: Env): Promise<CryptoKey> {
  const secret = env.CHATBOX_API_KEY;
  if (!secret) throw new Error("CHATBOX_API_KEY is required to keep the ChatGPT sign-in");
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256",
    salt: new TextEncoder().encode("aelios.chatgpt-signin.v1"), info: new TextEncoder().encode("token-seal")
  }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function seal(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(env), new TextEncoder().encode(plain)));
  return `v1.${b64url(iv)}.${b64url(cipher)}`;
}
/** null when there is nothing stored or it no longer opens (the owner key changed). */
export async function unseal(env: Env, sealed: string | null): Promise<string | null> {
  const parts = (sealed || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(parts[1]) }, await sealKey(env), fromB64url(parts[2]));
    return new TextDecoder().decode(plain);
  } catch { return null; }
}

export async function loadConnection(env: Env): Promise<ConnectionRow | null> {
  return env.DB.prepare("SELECT * FROM chatgpt_connection WHERE id = 1").first<ConnectionRow>();
}
/** The host id is made once, before the first sign-in, and never changes. It is an opaque label, not a credential. */
export async function ensureConnection(env: Env): Promise<ConnectionRow> {
  const now = nowIso();
  await env.DB.prepare(`INSERT OR IGNORE INTO chatgpt_connection (id, ext_agent_host_id, status, created_at, updated_at)
    VALUES (1, ?, 'disconnected', ?, ?)`).bind(`aelios-${crypto.randomUUID()}`, now, now).run();
  const row = await loadConnection(env);
  if (!row) throw new Error("ChatGPT sign-in store is unavailable. Apply the D1 migrations first.");
  return row;
}

export interface Pending { state: string; verifier: string; nonce: string; redirect_uri: string; mode: "register" | "reauth"; created_at: number }
export async function createPending(env: Env, pending: Omit<Pending, "created_at">, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM chatgpt_login_pending WHERE created_at < ?").bind(now - PENDING_TTL_MS).run();
  await env.DB.prepare(`INSERT INTO chatgpt_login_pending (state, verifier, nonce, redirect_uri, mode, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(pending.state, pending.verifier, pending.nonce, pending.redirect_uri, pending.mode, now).run();
}
/** A callback is good once: the row is claimed by the delete, so a replayed address finds nothing. */
export async function takePending(env: Env, state: string, now = Date.now()): Promise<Pending | null> {
  const row = await env.DB.prepare("SELECT * FROM chatgpt_login_pending WHERE state = ?").bind(state).first<Pending>();
  if (!row) return null;
  const claimed = await env.DB.prepare("DELETE FROM chatgpt_login_pending WHERE state = ?").bind(state).run();
  if (claimed.meta?.changes !== 1) return null;
  return now - row.created_at > PENDING_TTL_MS ? null : row;
}

export interface SessionWrite {
  clientId: string;
  subject: string;
  email: string | null;
  scopes: string;
  planUsage: boolean;
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAt: number;
  earliestRefreshAt: number | null;
}
/** A fresh sign-in: replaces whatever was stored, and starts the one-time welcome over when the account changed. */
export async function saveSession(env: Env, write: SessionWrite, now = Date.now()): Promise<void> {
  const [access, refresh, id] = await Promise.all([
    seal(env, write.accessToken), seal(env, write.refreshToken), write.idToken ? seal(env, write.idToken) : null
  ]);
  const previous = await loadConnection(env);
  const sameAccount = previous?.subject === write.subject && previous?.client_id === write.clientId;
  await env.DB.prepare(`UPDATE chatgpt_connection SET client_id = ?, subject = ?, email = ?, scopes = ?, plan_usage = ?,
      access_token_enc = ?, refresh_token_enc = ?, id_token_enc = ?, access_expires_at = ?, earliest_refresh_at = ?,
      refreshed_at = ?, refresh_lease_until = NULL, refresh_lease_owner = NULL, refresh_retry_at = NULL,
      status = ?, last_error = NULL, welcomed = ?, updated_at = ? WHERE id = 1`)
    .bind(write.clientId, write.subject, write.email, write.scopes, write.planUsage ? 1 : 0, access, refresh, id,
      write.expiresAt, write.earliestRefreshAt, now, write.planUsage ? "connected" : "plan_disabled",
      sameAccount ? previous?.welcomed ?? 0 : 0, nowIso()).run();
}

export interface RefreshWrite {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  scopes: string | null;
  expiresAt: number;
  earliestRefreshAt: number | null;
}
/**
 * The rotated refresh token, the new access token, its expiry and the granted scopes go in together.
 * It only lands on the session it was made from: `expectedRefresh` is the stored refresh token as it was read, so a
 * refresh that raced a sign-out, or a newer sign-in (maybe another account), changes nothing and reports false.
 * Retried a few times: once OpenAI has rotated the token, this write is the only copy of the new one.
 */
export async function saveRefresh(env: Env, write: RefreshWrite, expectedRefresh: string, now = Date.now()): Promise<boolean> {
  const access = await seal(env, write.accessToken);
  const refresh = write.refreshToken ? await seal(env, write.refreshToken) : null;
  const id = write.idToken ? await seal(env, write.idToken) : null;
  const planKnown = write.scopes !== null;
  const planUsage = hasPlanScope(write.scopes);
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const result = await env.DB.prepare(`UPDATE chatgpt_connection SET access_token_enc = ?,
          refresh_token_enc = COALESCE(?, refresh_token_enc), id_token_enc = COALESCE(?, id_token_enc),
          scopes = COALESCE(?, scopes), plan_usage = CASE WHEN ? THEN ? ELSE plan_usage END,
          status = CASE WHEN ? THEN (CASE WHEN ? THEN 'connected' ELSE 'plan_disabled' END) ELSE status END,
          access_expires_at = ?, earliest_refresh_at = ?, refreshed_at = ?, refresh_retry_at = NULL, last_error = NULL, updated_at = ?
        WHERE id = 1 AND status IN ('connected', 'plan_disabled') AND refresh_token_enc = ?`)
        .bind(access, refresh, id, write.scopes, planKnown ? 1 : 0, planUsage ? 1 : 0, planKnown ? 1 : 0, planUsage ? 1 : 0,
          write.expiresAt, write.earliestRefreshAt, now, nowIso(), expectedRefresh).run();
      return result.meta?.changes === 1;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

/**
 * Tokens are gone; the account, client id and host id stay so the next sign-in reuses the same registration.
 * With `onlyIfRefresh` it clears just the session that holds that refresh token, so a verdict about an old
 * token (it was rejected) cannot wipe a newer sign-in that replaced it in the meantime.
 */
export async function clearSession(env: Env, status: "disconnected" | "needs_login", lastError: string | null,
    onlyIfRefresh?: string): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE chatgpt_connection SET access_token_enc = NULL, refresh_token_enc = NULL, id_token_enc = NULL,
      access_expires_at = NULL, earliest_refresh_at = NULL, refresh_lease_until = NULL, refresh_lease_owner = NULL,
      refresh_retry_at = NULL, status = ?, last_error = ?, updated_at = ?
    WHERE id = 1 AND (? IS NULL OR refresh_token_enc = ?)`)
    .bind(status, lastError, nowIso(), onlyIfRefresh ?? null, onlyIfRefresh ?? null).run();
  return result.meta?.changes === 1;
}
/** Forget the registration too: the next sign-in starts over as a new client (a different ChatGPT account). */
export async function forgetRegistration(env: Env): Promise<void> {
  await env.DB.prepare(`UPDATE chatgpt_connection SET client_id = NULL, subject = NULL, email = NULL, scopes = '',
      plan_usage = 0, welcomed = 0, updated_at = ? WHERE id = 1`).bind(nowIso()).run();
}
/** A refresh that failed for a reason that may pass: say so, and hold off asking ChatGPT again until `retryAt`. */
export async function recordRefreshFailure(env: Env, message: string, retryAt: number, expectedRefresh: string): Promise<void> {
  await env.DB.prepare(`UPDATE chatgpt_connection SET last_error = ?, refresh_retry_at = ?, updated_at = ?
    WHERE id = 1 AND refresh_token_enc = ?`).bind(message.slice(0, 300), retryAt, nowIso(), expectedRefresh).run();
}
export async function markWelcomed(env: Env): Promise<void> {
  await env.DB.prepare("UPDATE chatgpt_connection SET welcomed = 1, updated_at = ? WHERE id = 1").bind(nowIso()).run();
}

/**
 * One refresher at a time: the refresh token rotates, so a second concurrent refresh would burn the first one's.
 * The lease has an owner. Only the holder can put it back, so a refresh that ran past its lease cannot release the
 * lease of whoever took over.
 */
export async function claimRefreshLease(env: Env, now: number, leaseMs: number): Promise<string | null> {
  const owner = crypto.randomUUID();
  const result = await env.DB.prepare(`UPDATE chatgpt_connection SET refresh_lease_until = ?, refresh_lease_owner = ?
    WHERE id = 1 AND (refresh_lease_until IS NULL OR refresh_lease_until < ?)`).bind(now + leaseMs, owner, now).run();
  return result.meta?.changes === 1 ? owner : null;
}
export async function releaseRefreshLease(env: Env, owner: string): Promise<void> {
  await env.DB.prepare(`UPDATE chatgpt_connection SET refresh_lease_until = NULL, refresh_lease_owner = NULL
    WHERE id = 1 AND refresh_lease_owner = ?`).bind(owner).run();
}
