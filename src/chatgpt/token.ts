import type { Env } from "../types";
import { OAuthError, parseInstant, refreshTokens, revokeToken, TERMINAL_REFRESH_ERRORS, type TokenSet } from "./oauth";
import {
  claimRefreshLease, clearSession, loadConnection, recordRefreshFailure, releaseRefreshLease, saveRefresh, unseal,
  type ConnectionRow
} from "./store";

/** Why there is no usable token: the owner has to do something (login / plan), or it is worth trying again. */
export type AuthFailure = "not_connected" | "needs_login" | "plan_disabled" | "unavailable";
export class ChatGptAuthError extends Error {
  constructor(readonly kind: AuthFailure, message: string, readonly status: number) {
    super(message);
    this.name = "ChatGptAuthError";
  }
}

export interface AccessGrant { accessToken: string; clientId: string }
export interface GrantOptions {
  /** Refresh even if the token is fresh (a 401 says it is not). Skipped when it was refreshed a moment ago. */
  force?: boolean;
  waitMs?: number;
  pollMs?: number;
  /**
   * The platform's `waitUntil`. A refresh rotates the refresh token, so once ChatGPT has answered, saving the new one
   * must not die with a client that hung up; handing the refresh to this keeps it running.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** Refresh this long before expiry so a request never starts with a token about to lapse. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Well past the token call's own timeout, so a lease only lapses on a refresh that is truly gone. */
const LEASE_MS = 45_000;
/** A token this close to its end is not worth sending a request with. */
const USABLE_MS = 15_000;
const FORCE_GAP_MS = 60_000;
/** After a refresh failed for a reason that may pass, ChatGPT is left alone this long instead of asked on every request. */
export const RETRY_AFTER_FAILURE_MS = 30_000;
/** The refresh token lives 30 days and is renewed by each refresh; refresh when idle this long. */
export const KEEP_ALIVE_AFTER_MS = 7 * 24 * 3600_000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const needsLogin = (message: string) => new ChatGptAuthError("needs_login", message, 503);
const UNREADABLE = "The stored ChatGPT sign-in can no longer be read (the owner key changed?). Sign in again from /admin.";

function assertSignedIn(row: ConnectionRow | null, planDisabledOk = false): ConnectionRow {
  if (!row || !row.client_id || (!row.refresh_token_enc && row.status !== "needs_login")) {
    throw new ChatGptAuthError("not_connected", "ChatGPT is not connected. Sign in from /admin.", 503);
  }
  if (row.status === "needs_login") throw needsLogin("The ChatGPT sign-in expired. Sign in again from /admin.");
  if (row.status === "plan_disabled" && !planDisabledOk) {
    throw new ChatGptAuthError("plan_disabled", "ChatGPT is signed in but plan usage was not granted. Authorize it again from /admin.", 403);
  }
  if (row.status !== "connected" && row.status !== "plan_disabled") {
    throw new ChatGptAuthError("not_connected", "ChatGPT is not connected. Sign in from /admin.", 503);
  }
  return row;
}

/**
 * Tokens that no longer open are reported, not erased: the cause can be a secret that is briefly missing or a
 * second deployment still running the other key, and wiping would turn that into a lost grant. A fresh sign-in
 * replaces them anyway.
 */
async function grantFrom(env: Env, row: ConnectionRow): Promise<AccessGrant> {
  const accessToken = await unseal(env, row.access_token_enc);
  if (!accessToken || !row.client_id) throw needsLogin(UNREADABLE);
  return { accessToken, clientId: row.client_id };
}

/** Terminal means this refresh token is dead; anything else (network, 5xx, rate limit) keeps the sign-in. */
function describeRefreshFailure(error: unknown): string {
  if (error instanceof OAuthError) return `refresh failed (${error.code})`;
  return "refresh failed (network)";
}

/**
 * The access token for one request, refreshed first when it is near its end.
 * Refreshing rotates the refresh token, so it runs under a lease held in D1: the other isolates either keep
 * using the still-valid token or wait for the new one, and none of them refreshes with a token that was just spent.
 */
export async function getAccessGrant(env: Env, options: GrantOptions = {}): Promise<AccessGrant> {
  if (!env.CHATBOX_API_KEY) {
    throw new ChatGptAuthError("unavailable", "CHATBOX_API_KEY is missing, so the stored ChatGPT sign-in cannot be opened.", 503);
  }
  const deadline = Date.now() + (options.waitMs ?? 8000);
  for (;;) {
    const row = assertSignedIn(await loadConnection(env));
    const now = Date.now();
    const remaining = (row.access_expires_at ?? 0) - now;
    const forced = options.force === true && now - (row.refreshed_at ?? 0) > FORCE_GAP_MS;
    if (!forced) {
      if (remaining > REFRESH_MARGIN_MS) return grantFrom(env, row);
      // OpenAI can name an earliest moment for the next refresh; a token that still works waits for it.
      if (remaining > USABLE_MS && row.earliest_refresh_at && now < row.earliest_refresh_at) return grantFrom(env, row);
      // A refresh failed a moment ago for a reason that may pass; do not ask again on every request.
      if (row.refresh_retry_at && now < row.refresh_retry_at) {
        if (remaining > USABLE_MS) return grantFrom(env, row);
        throw new ChatGptAuthError("unavailable", "Could not refresh the ChatGPT sign-in a moment ago; it will be tried again shortly.", 503);
      }
    }
    const owner = await claimRefreshLease(env, now, LEASE_MS);
    if (owner) return refreshUnderLease(env, owner, { forced, waitUntil: options.waitUntil });
    // Someone else is refreshing. A token that still has time is enough, unless this call is the retry after that very
    // token was refused (a 401): then wait for theirs, since the one in hand is the one that failed.
    if (!forced && remaining > USABLE_MS) return grantFrom(env, row);
    if (Date.now() >= deadline) throw new ChatGptAuthError("unavailable", "ChatGPT sign-in is being refreshed; try again in a moment.", 503);
    await sleep(options.pollMs ?? 200);
  }
}

interface RefreshOptions { forced: boolean; allowPlanDisabled?: boolean; waitUntil?: GrantOptions["waitUntil"] }

/** The refresh and the lease release as one piece of work, so handing it to `waitUntil` covers both. */
function refreshUnderLease(env: Env, owner: string, options: RefreshOptions): Promise<AccessGrant> {
  const work = (async () => {
    try { return await refreshOnce(env, options); }
    finally { await releaseRefreshLease(env, owner).catch(() => undefined); }
  })();
  options.waitUntil?.(work.then(() => undefined, () => undefined));
  return work;
}

async function refreshOnce(env: Env, options: RefreshOptions): Promise<AccessGrant> {
  // Re-read under the lease: the previous holder may have finished between our read and our claim.
  const row = assertSignedIn(await loadConnection(env), options.allowPlanDisabled);
  const now = Date.now();
  const remaining = (row.access_expires_at ?? 0) - now;
  if (!options.forced && remaining > REFRESH_MARGIN_MS) return grantFrom(env, row);
  // Everything below is about this one session, named by the refresh token it holds right now.
  const expected = row.refresh_token_enc;
  const refreshToken = expected ? await unseal(env, expected) : null;
  if (!expected || !refreshToken || !row.client_id) throw needsLogin(UNREADABLE);
  let tokens: TokenSet;
  try { tokens = await refreshTokens({ clientId: row.client_id, refreshToken }); }
  catch (error) {
    if (error instanceof OAuthError && TERMINAL_REFRESH_ERRORS.has(error.code)) {
      const cleared = await clearSession(env, "needs_login", `refresh token rejected (${error.code})`, expected);
      // Nothing to clear means a newer sign-in already replaced the rejected one; this request can use that.
      if (!cleared) return grantFrom(env, assertSignedIn(await loadConnection(env), options.allowPlanDisabled));
      throw needsLogin("ChatGPT no longer accepts this sign-in (it may have been disconnected). Sign in again from /admin.");
    }
    await recordRefreshFailure(env, describeRefreshFailure(error), Date.now() + RETRY_AFTER_FAILURE_MS, expected).catch(() => undefined);
    // A refresh that fails for any other reason keeps the sign-in; the old token serves while it lasts.
    if (remaining > USABLE_MS) return grantFrom(env, row);
    if (error instanceof OAuthError && error.code === "invalid_client") {
      throw new ChatGptAuthError("unavailable", "ChatGPT rejected this client registration (invalid_client).", 502);
    }
    throw new ChatGptAuthError("unavailable", "Could not refresh the ChatGPT sign-in; try again in a moment.", 503);
  }
  const saved = await saveRefresh(env, {
    accessToken: tokens.access_token, refreshToken: tokens.refresh_token || null, idToken: tokens.id_token || null,
    scopes: typeof tokens.scope === "string" ? tokens.scope : null,
    expiresAt: Date.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000,
    earliestRefreshAt: parseInstant(tokens.earliest_refresh_at)
  }, expected);
  if (!saved && tokens.refresh_token) {
    // The session changed while ChatGPT was answering: signed out, or signed in again (maybe as someone else).
    // What came back belongs to the old session, so hand it back instead of leaving a grant nobody holds.
    // But a write that landed and then reported an error looks the same from here, and revoking the token that
    // is now stored would lose the session; so look at what is stored before giving anything back.
    const current = await loadConnection(env).catch(() => null);
    const stored = current?.refresh_token_enc ? await unseal(env, current.refresh_token_enc) : null;
    if (stored !== tokens.refresh_token) await revokeToken({ clientId: row.client_id, refreshToken: tokens.refresh_token });
  }
  return grantFrom(env, assertSignedIn(await loadConnection(env), options.allowPlanDisabled));
}

/**
 * Nightly: a sign-in nobody used for a week is refreshed once so its 30-day refresh token keeps renewing.
 * A signed-in account without plan usage is kept alive too, so authorizing it later does not mean starting over.
 * A failed keep-alive is only logged; the next real request finds out the same thing.
 */
export async function keepChatGptAlive(env: Env, now = Date.now()): Promise<"skipped" | "refreshed" | "failed"> {
  if (!env.CHATBOX_API_KEY) return "skipped";
  const row = await loadConnection(env).catch(() => null);
  if (!row || !row.refresh_token_enc || !["connected", "plan_disabled"].includes(row.status)) return "skipped";
  if (now - (row.refreshed_at ?? 0) < KEEP_ALIVE_AFTER_MS) return "skipped";
  if (row.refresh_retry_at && now < row.refresh_retry_at) return "skipped";
  const owner = await claimRefreshLease(env, now, LEASE_MS);
  if (!owner) return "skipped";
  try {
    const before = (await loadConnection(env))?.refreshed_at ?? 0;
    if (now - before < KEEP_ALIVE_AFTER_MS) return "skipped";
    await refreshOnce(env, { forced: true, allowPlanDisabled: true });
    return ((await loadConnection(env))?.refreshed_at ?? 0) > before ? "refreshed" : "failed";
  } catch (error) {
    console.error("chatgpt keep-alive failed", { error: error instanceof Error ? error.message : String(error) });
    return "failed";
  } finally { await releaseRefreshLease(env, owner).catch(() => undefined); }
}
