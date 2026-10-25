// Sign in with ChatGPT, open-source token sharing. Contract snapshot: 2026-10-25.
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
// https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
// https://developers.openai.com/siwc/token-sharing-open-source/token-reference
// https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
// Endpoints come from https://auth.openai.com/.well-known/openid-configuration.
// No client secret: the issued client_id is public and every exchange is PKCE.

export const ISSUER = "https://auth.openai.com";
export const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
export const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
export const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
export const RESOURCE = "https://api.openai.com/v1";
/** First sign-in only: an entry point, never the id to save or to exchange with. */
export const REGISTER_CLIENT_ID = "dynamic_agent_client";
export const AGENT_NAME = "Aelios";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
/**
 * Must be a 127.0.0.1 loopback (not localhost). A Worker cannot listen there, so the browser lands on a
 * page that fails to load and the owner pastes that address into /admin; the code is in its query string.
 */
export const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";

/** Refresh failures that mean this refresh token is gone for good: clear it and sign in again. */
export const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
  "refresh_token_invalidated", "refresh_token_reused"
]);

export class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "OAuthError";
  }
}

export function b64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}
export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export interface AuthorizeParams {
  /** The issued client id; omitted on the first sign-in, which registers with the entry-point id. */
  clientId: string | null;
  hostId: string;
  state: string;
  nonce: string;
  challenge: string;
  /** Returning sign-in: skips the account picker. May be expired. */
  idTokenHint?: string | null;
  loginHint?: string | null;
  /** Ask for the plan permission again (`prompt=consent`); not `force_reconsent`, which needs OpenAI's go-ahead. */
  reconsent?: boolean;
}
export function buildAuthorizeUrl(params: AuthorizeParams): string {
  const register = !params.clientId;
  const url = new URL(AUTHORIZE_URL);
  const query = url.searchParams;
  query.set("response_type", "code");
  query.set("client_id", params.clientId || REGISTER_CLIENT_ID);
  query.set("redirect_uri", REDIRECT_URI);
  query.set("scope", SCOPES);
  query.set("resource", RESOURCE);
  query.set("state", params.state);
  query.set("nonce", params.nonce);
  query.set("code_challenge", params.challenge);
  query.set("code_challenge_method", "S256");
  query.set("ext_agent_host_id", params.hostId);
  // The app name is sent once, when the client is created; a returning sign-in names the account instead.
  if (register) query.set("agent_name_hint", AGENT_NAME);
  else {
    if (params.idTokenHint) query.set("id_token_hint", params.idTokenHint);
    if (params.loginHint) query.set("login_hint", params.loginHint);
  }
  if (params.reconsent) query.set("prompt", "consent");
  return url.toString();
}
/** The authorize URL carries id_token_hint and login_hint; nothing that logs it may keep them. */
export function redactAuthorizeUrl(url: string): string {
  return url.replace(/([?&](?:id_token_hint|login_hint|code_challenge|state|nonce)=)[^&#]*/g, "$1[redacted]");
}

export interface CallbackParams {
  code?: string;
  state?: string;
  scope?: string;
  clientId?: string;
  error?: string;
  errorDescription?: string;
}
/** Takes the whole pasted address (what the browser could not load), or just its query string. */
export function parseCallback(input: string): CallbackParams {
  const raw = input.trim();
  let query: URLSearchParams;
  try { query = new URL(raw).searchParams; }
  catch { query = new URLSearchParams(raw.replace(/^[^?=]*\?/, "")); }
  const pick = (name: string) => query.get(name) || undefined;
  return {
    code: pick("code"), state: pick("state"), scope: pick("scope"), clientId: pick("client_id"),
    error: pick("error"), errorDescription: pick("error_description")
  };
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  earliest_refresh_at?: unknown;
}
/** `error` is either a code string or an object with a code, depending on the endpoint. */
function errorFields(body: unknown): { code: string; message: string } {
  const root: Record<string, unknown> = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : null;
  const text = (value: unknown) => typeof value === "string" ? value : "";
  return {
    code: text(root.error) || text(error?.code) || text(root.code),
    message: text(root.error_description) || text(error?.message) || text(root.message)
  };
}
/**
 * A token call that never answers would hold the refresh lease for good, so it is cut off well inside the lease.
 * (An answer lost this way may still have rotated the token on OpenAI's side; the next refresh then reads as
 * `refresh_token_reused`, which is what asks for a new sign-in.)
 */
export const TOKEN_TIMEOUT_MS = 20_000;
async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const response = await fetch(TOKEN_URL, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params)
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const { code, message } = errorFields(body);
    throw new OAuthError(code || `http_${response.status}`, message || `Token endpoint answered ${response.status}`, response.status);
  }
  const set = body as TokenSet | null;
  if (!set || typeof set.access_token !== "string" || !set.access_token) {
    throw new OAuthError("invalid_token_response", "Token endpoint did not return an access token", 502);
  }
  return set;
}
export function exchangeCode(params: { clientId: string; code: string; verifier: string; redirectUri: string }): Promise<TokenSet> {
  return tokenRequest({
    grant_type: "authorization_code", client_id: params.clientId, code: params.code,
    code_verifier: params.verifier, redirect_uri: params.redirectUri, resource: RESOURCE
  });
}
/** `scope` is omitted on purpose: that keeps the grant as it was. */
export function refreshTokens(params: { clientId: string; refreshToken: string }): Promise<TokenSet> {
  return tokenRequest({
    grant_type: "refresh_token", client_id: params.clientId, refresh_token: params.refreshToken, resource: RESOURCE
  });
}
/** An empty 200 is success, and also what an already-invalid token gets. */
export async function revokeToken(params: { clientId: string; refreshToken: string }): Promise<boolean> {
  try {
    const response = await fetch(REVOKE_URL, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: params.refreshToken, token_type_hint: "refresh_token", client_id: params.clientId })
    });
    await response.arrayBuffer().catch(() => undefined);
    return response.status === 200;
  } catch { return false; }
}

export function hasPlanScope(scope: string | null | undefined): boolean {
  return (scope || "").split(/\s+/).includes(PLAN_SCOPE);
}
/** `earliest_refresh_at` is documented as a field and nothing more; take seconds, milliseconds or a date string. */
export function parseInstant(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e11 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) return parseInstant(asNumber);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export interface IdClaims {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  nonce?: string;
  email?: string;
}
type Jwk = JsonWebKey & { kid?: string };
let jwksCache: { keys: Jwk[]; expires: number } | null = null;
export function resetOAuthCaches(): void { jwksCache = null; }
async function loadJwks(force = false): Promise<Jwk[]> {
  if (!force && jwksCache && jwksCache.expires > Date.now()) return jwksCache.keys;
  const response = await fetch(JWKS_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new OAuthError("jwks_unavailable", `JWKS answered ${response.status}`, 502);
  const body = await response.json() as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache = { keys, expires: Date.now() + 3600_000 };
  return keys;
}
const utf8 = new TextDecoder();
/**
 * Signature against OpenAI's JWKS, then issuer, audience (the issued client id), expiry and nonce.
 * A valid ID token proves who signed in, not that plan usage was granted: check the scopes too.
 */
export async function verifyIdToken(idToken: string, expect: { clientId: string; nonce?: string; now?: number }): Promise<IdClaims> {
  const bad = (message: string) => new OAuthError("invalid_id_token", message, 502);
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some(part => !part)) throw bad("ID token is not a JWT");
  const [headerPart, payloadPart, signaturePart] = parts;
  let header: { alg?: string; kid?: string };
  let claims: IdClaims;
  try {
    header = JSON.parse(utf8.decode(fromB64url(headerPart)));
    claims = JSON.parse(utf8.decode(fromB64url(payloadPart)));
  } catch { throw bad("ID token is not valid JSON"); }
  if (header.alg !== "RS256") throw bad("ID token must be signed with RS256");
  let jwk = (await loadJwks()).find(key => key.kid === header.kid);
  if (!jwk) jwk = (await loadJwks(true)).find(key => key.kid === header.kid);
  if (!jwk) throw bad("ID token signing key is unknown");
  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(signaturePart), new TextEncoder().encode(`${headerPart}.${payloadPart}`));
  } catch { throw bad("ID token signature could not be checked"); }
  if (!valid) throw bad("ID token signature does not match");
  if (claims.iss !== ISSUER) throw bad("ID token issuer is not OpenAI");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(expect.clientId)) throw bad("ID token was issued to a different client");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < (expect.now ?? Date.now()) - 60_000) throw bad("ID token has expired");
  if (expect.nonce !== undefined && claims.nonce !== expect.nonce) throw bad("ID token nonce does not match this sign-in");
  if (typeof claims.sub !== "string" || !claims.sub) throw bad("ID token has no subject");
  return claims;
}
