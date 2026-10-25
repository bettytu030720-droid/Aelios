// Errors on the ChatGPT plan route. Contract snapshot: 2026-10-25.
// https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
// The codes are matched exactly; the message text is diagnostic only. Before a stream opens the body can be
// {"detail": "..."} instead of an `error` object, and a usage-limit failure can also arrive as `response.failed`.
import { object } from "../gateway/config";
import type { Body } from "../gateway/protocol";
import { redactSecrets } from "../utils/redact";

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  param: string | null;
  requestId: string | null;
  /** The upstream's `Retry-After`, passed on as it came so a client can honor it. */
  retryAfter?: string | null;
}
export class ChatGptApiError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
    this.name = "ChatGptApiError";
  }
}

/** What each documented code means for the person at the keyboard. 401 is never passed on as 401: to a chat app that means "your Aelios key is wrong". */
const KNOWN: Record<string, { status: number; hint: string }> = {
  subscription_sharing_user_not_eligible: { status: 403,
    hint: "This ChatGPT account or workspace can't use its plan through apps. Retrying or signing in again won't change that." },
  subscription_sharing_usage_limit_exceeded: { status: 429,
    hint: "ChatGPT plan usage limit reached. Check ChatGPT settings → Usage (\"Manage usage\"); the limit may be this app's own." },
  subscription_sharing_usage_unavailable: { status: 503,
    hint: "ChatGPT could not check plan usage just now. Try again shortly." },
  subscription_sharing_user_unavailable: { status: 503,
    hint: "ChatGPT plan usage is temporarily unavailable. Try again shortly." },
  subscription_sharing_unsupported_capability: { status: 400,
    hint: "ChatGPT plan usage does not support something in this request." },
  subscription_sharing_route_not_supported: { status: 403,
    hint: "ChatGPT plan usage does not cover this endpoint or method." },
  subscription_sharing_invalid_user: { status: 502,
    hint: "ChatGPT did not accept the sign-in. If it keeps happening, sign in again from /admin." },
  chatpass_v2_scope_not_authorized: { status: 403,
    hint: "ChatGPT says this client was not granted that scope. Authorize ChatGPT again from /admin." },
  chatpass_v2_invalid_authorization_context: { status: 403,
    hint: "ChatGPT rejected this client's authorization context. Authorize ChatGPT again from /admin." }
};
/** Codes worth another try after a pause. The rest need the owner (or a different request), not a retry. */
export const RETRYABLE_CODES = new Set(["subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable"]);

function bareStatusHint(status: number): string {
  if (status === 401) return "ChatGPT did not accept the access token.";
  if (status === 403) return "ChatGPT refused the request. It can be a region or policy restriction on where this Worker connects from.";
  if (status === 503) return "ChatGPT plan usage is not reachable right now. Try again shortly.";
  if (status === 429) return "ChatGPT is rate limiting this request.";
  return `ChatGPT answered ${status}.`;
}
/** The status a client should see: 401 becomes 502, unknown 5xx becomes 502, the rest pass through. */
function clientStatus(failure: ApiFailure): number {
  const known = KNOWN[failure.code];
  if (known) return known.status;
  if (failure.status === 401) return 502;
  if (failure.status === 503) return 503;
  if (failure.status >= 500) return 502;
  return failure.status >= 400 ? failure.status : 502;
}
export function describeFailure(failure: ApiFailure): { status: number; type: string; code: string; message: string; param: string | null } {
  const status = clientStatus(failure);
  const hint = KNOWN[failure.code]?.hint ?? bareStatusHint(failure.status);
  // A 401's wording can echo part of the credential it refused, so that one is never repeated; everything else is
  // run through the secret filter first.
  const text = failure.status === 401 ? "" : redactSecrets(failure.message);
  const detail = text && !hint.includes(text) ? ` (${text.slice(0, 240)})` : "";
  const param = failure.code === "subscription_sharing_unsupported_capability" && failure.param ? ` Field: ${failure.param}.` : "";
  return {
    status, code: failure.code || `http_${failure.status}`, param: failure.param,
    type: status === 429 ? "rate_limit_error" : status >= 500 ? "api_error" : "invalid_request_error",
    message: `${hint}${param}${detail}`
  };
}
/** The two error envelopes a client can expect: OpenAI's `{error:{...}}` and Anthropic's `{type:"error", error:{...}}`. */
export type ErrorShape = "openai" | "anthropic";
const ANTHROPIC_TYPES: Record<number, string> = {
  400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error",
  429: "rate_limit_error", 503: "overloaded_error"
};
export function anthropicErrorType(status: number): string {
  return ANTHROPIC_TYPES[status] ?? (status >= 500 ? "api_error" : "invalid_request_error");
}
export function errorBody(failure: ApiFailure, shape: ErrorShape = "openai"): Body {
  const described = describeFailure(failure);
  if (shape === "anthropic") {
    return { type: "error", error: { type: anthropicErrorType(described.status), message: described.message },
      ...(failure.requestId ? { request_id: failure.requestId } : {}) };
  }
  return { error: { message: described.message, type: described.type, code: described.code, param: described.param,
    ...(failure.requestId ? { request_id: failure.requestId } : {}) } };
}
export function errorResponse(failure: ApiFailure, headers: HeadersInit = {}, shape: ErrorShape = "openai"): Response {
  const out = new Headers(headers);
  out.set("content-type", "application/json; charset=utf-8");
  out.set("cache-control", "no-store");
  if (failure.requestId) out.set("x-request-id", failure.requestId);
  if (failure.retryAfter) out.set("retry-after", failure.retryAfter);
  return new Response(JSON.stringify(errorBody(failure, shape)), { status: describeFailure(failure).status, headers: out });
}

/** A non-2xx answer from the Responses API or the model catalog. */
export async function readFailure(response: Response): Promise<ApiFailure> {
  const text = await response.text().catch(() => "");
  let body: Body | null = null;
  try { const parsed = text ? JSON.parse(text) : null; body = object(parsed) ? parsed : null; } catch { body = null; }
  const error = object(body?.error) ? body?.error as Body : null;
  return {
    status: response.status,
    code: typeof error?.code === "string" ? error.code : typeof body?.code === "string" ? body.code : "",
    message: typeof error?.message === "string" ? error.message : typeof body?.detail === "string" ? body.detail
      : typeof body?.error === "string" ? body.error : (text && !body ? text.slice(0, 200) : ""),
    param: typeof error?.param === "string" ? error.param : null,
    requestId: response.headers.get("x-request-id"), retryAfter: response.headers.get("retry-after")
  };
}
/**
 * A failure inside a stream has no HTTP status of its own. Read one off the code, so a chat app can tell "slow down"
 * from "this request is wrong" from "ChatGPT is having a bad moment", and not retry the middle one forever.
 */
function statusForCode(code: string): number {
  const c = code.toLowerCase();
  if (/rate_limit|usage_limit|quota|too_many/.test(c)) return 429;
  if (/overloaded|unavailable|temporar|timeout|busy/.test(c)) return 503;
  if (/context_length|too_long|invalid_|unsupported|not_supported|content_policy|bad_request|max_tokens|image_/.test(c)) return 400;
  return 502;
}
/** `response.failed` carries the error on the response; a bare `error` event carries it at the top. */
export function failureFromEvent(event: Body, requestId: string | null = null): ApiFailure {
  const source = object(event.response?.error) ? event.response.error as Body : object(event.error) ? event.error as Body : event;
  const code = typeof source.code === "string" ? source.code : typeof source.type === "string" ? source.type : "";
  const known = KNOWN[code];
  return {
    status: known?.status ?? statusForCode(code), code,
    message: typeof source.message === "string" ? source.message : "ChatGPT ended the response with an error.",
    param: typeof source.param === "string" ? source.param : null, requestId
  };
}
export const STREAM_ENDED: ApiFailure = {
  status: 502, code: "stream_ended", param: null, requestId: null,
  message: "ChatGPT closed the stream before the response completed."
};
