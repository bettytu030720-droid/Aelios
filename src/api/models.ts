import { authenticate } from "../auth/apiKey";
import type { Env } from "../types";
import { json, openAiError } from "../utils/json";
import { findIdentity, isMainModel, loadConfig, type GatewayConfig, type Identity } from "../gateway/config";
import { callGatewayUpstream, catalogUrl, prepareGatewayRequest } from "../gateway/upstream";
import { ownerOnly } from "../gateway/admin";
import { readJsonObject } from "../utils/request";
import { listChatGptModels, MODEL_PREFIX, TIMEOUTS } from "../chatgpt/client";
import { loadConnection } from "../chatgpt/store";

/** The owner's ChatGPT models, named the way the gateway routes them. Never worth failing the whole list over. */
async function chatGptEntries(env: Env, signal: AbortSignal, ctx?: ExecutionContext): Promise<Record<string, unknown>[]> {
  const list = (async () => {
    try {
      if ((await loadConnection(env))?.status !== "connected") return [];
      return (await listChatGptModels(env, { signal, waitUntil: ctx ? promise => ctx.waitUntil(promise) : undefined })).map(model => ({
        id: `${MODEL_PREFIX}${model.slug}`, object: "model", created: 0, owned_by: "chatgpt", display_name: model.name }));
    } catch { return []; }
  })();
  // Chat apps ask for this list before anything else; a slow ChatGPT costs them its models, not the whole list.
  return Promise.race([list, new Promise<[]>(resolve => setTimeout(() => resolve([]), TIMEOUTS.modelsMs + 1000))]);
}

/**
 * One line of the owner's model list, in the shape /v1/models gives its entries. `aelios.main` says whether a chat
 * on this model gets memory (recall and recording) under the identity asking: a picker can mark the ones that do not
 * before anyone tries them. Other clients ignore the extra field.
 */
function listedEntry(id: string, identity: Identity): Record<string, unknown> {
  const slash = id.indexOf("/");
  return { id, object: "model", created: 0, owned_by: slash > 0 ? id.slice(0, slash) : identity.slug,
    aelios: { main: isMainModel(identity, id) } };
}

/** GET {catalog}; a string is the reason it could not be had. */
async function fetchUpstreamCatalog(env: Env, config: GatewayConfig, signal: AbortSignal): Promise<Response | string> {
  // The catalog lives on the AI Gateway compat surface; CF REST has no GET /models (405).
  const token = env.CLOUDFLARE_API_TOKEN;
  const address = config.upstream?.address?.trim() || env.AI_GATEWAY_BASE_URL || env.CLOUDFLARE_ACCOUNT_ID || "";
  if (!token) return "no-token";
  if (!address) return "no-address";
  try {
    const upstream = await fetch(catalogUrl(env, config), { headers: { authorization: `Bearer ${token}` }, signal });
    return upstream.ok ? upstream : `upstream-${upstream.status}`;
  } catch { return "upstream-error"; }
}

/**
 * The upstream owns the real catalog; local main models are only hints when it cannot answer.
 * With a model list saved, the list is the answer: it only decides what the picker shows, never what can be called.
 */
export async function handleModels(request: Request, env: Env, slug: string | null = null, ctx?: ExecutionContext): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  let config: GatewayConfig;
  try { config = await loadConfig(env); }
  catch { return openAiError("Gateway configuration unavailable. Apply migrations.", 503); }

  const identity = findIdentity(config, auth, slug);
  if (!identity) return openAiError("No identity available for this key. Configure /admin.", 403);

  // Nothing is fetched: the list does not depend on the upstream being up, and the thousand-model catalog never leaves it.
  if (config.modelList?.length) {
    return json({ object: "list", data: config.modelList.map(id => listedEntry(id, identity)) },
      { headers: { "Cache-Control": "private, no-store", "x-aelios-identity": identity.slug, "x-aelios-models": "list" } });
  }

  const chatgpt = chatGptEntries(env, request.signal, ctx);
  const fetched = await fetchUpstreamCatalog(env, config, request.signal);
  let reason = "";
  if (typeof fetched !== "string") {
    const upstream = fetched;
    const headers = { "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "private, no-store", "x-aelios-identity": identity.slug, "x-aelios-models": "upstream" };
    const extra = await chatgpt;
    // Without ChatGPT models the body goes through untouched, exactly as before.
    if (!extra.length) return new Response(upstream.body, { status: 200, headers });
    const text = await upstream.text();
    try {
      const catalog = JSON.parse(text);
      if (Array.isArray(catalog?.data)) return json({ ...catalog, data: [...catalog.data, ...extra] }, { headers });
    } catch { /* not JSON we can add to: hand it over as it came */ }
    return new Response(text, { status: 200, headers });
  }
  reason = fetched;
  return json(
    {
      object: "list",
      data: [...identity.models
        .filter(model => !model.includes("*"))
        .map(model => ({ id: model, object: "model", created: 0, owned_by: identity.slug })), ...await chatgpt]
    },
    { headers: { "Cache-Control": "private, no-store", "x-aelios-models": `fallback:${reason}` } }
  );
}

/**
 * What the owner can pick from in /admin: every model id the upstream lists, the owner's ChatGPT models, and the
 * saved list. The picker needs only the ids, so thousands of catalog entries stay a few hundred KB.
 */
export async function handleModelCatalog(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!await ownerOnly(request, env)) return Response.json({ error: "Owner key required" }, { status: 401 });
  let config: GatewayConfig;
  try { config = await loadConfig(env); }
  catch { return Response.json({ error: "Gateway configuration unavailable. Apply migrations." }, { status: 503 }); }
  const chatgpt = chatGptEntries(env, request.signal, ctx);
  const fetched = await fetchUpstreamCatalog(env, config, request.signal);
  const models: string[] = [];
  let reason = "";
  if (typeof fetched === "string") reason = fetched;
  else {
    try {
      const catalog = await fetched.json() as { data?: unknown };
      if (Array.isArray(catalog?.data)) {
        for (const entry of catalog.data) {
          const id = (entry as { id?: unknown } | null)?.id;
          if (typeof id === "string" && id.trim() && !models.includes(id)) models.push(id);
        }
      } else reason = "unexpected-catalog";
    } catch { reason = "unexpected-catalog"; }
  }
  const extra = (await chatgpt).map(entry => String(entry.id));
  return Response.json({ list: config.modelList || [], models: models.sort(), chatgpt: extra, source: reason ? "unavailable" : "upstream", reason },
    { headers: { "cache-control": "no-store" } });
}

const TEST_TIMEOUT_MS = 25_000;
/** The caller of a connectivity test is the owner, not an assistant: no memory, no recording, no thinking policy. */
const TEST_IDENTITY = { slug: "model-test", keys: [], models: [] };

/** The first words an upstream said about why it refused; capped, so a page of HTML never reaches the panel. */
function refusalText(text: string): string {
  try {
    const data = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof data.error === "string" ? data.error : data.error?.message ?? data.message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
  } catch { /* not JSON: fall through to the raw start */ }
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * One real, tiny chat request to a listed model, sent the way a chat client's request is (same route, same
 * ChatGPT-plan branch), without recording anything. A pass is a chat.completion back; whatever else came back is
 * reported with the upstream's own words. OpenAI's reasoning models want max_completion_tokens where others want
 * max_tokens, so a 400 asking for it is tried once more with it.
 */
export async function handleModelTest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!await ownerOnly(request, env)) return Response.json({ error: "Owner key required" }, { status: 401 });
  const input = await readJsonObject(request);
  const model = typeof input?.model === "string" ? input.model.trim() : "";
  if (!model || model.length > 200 || /\s/.test(model)) {
    return Response.json({ error: "model must be a model name without spaces" }, { status: 400 });
  }
  let config: GatewayConfig;
  try { config = await loadConfig(env); }
  catch { return Response.json({ error: "Gateway configuration unavailable. Apply migrations." }, { status: 503 }); }

  const started = Date.now();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TEST_TIMEOUT_MS)]);
  const attempt = async (capField: "max_tokens" | "max_completion_tokens"): Promise<Response> => {
    const sent = new Request("https://aelios.invalid/v1/chat/completions", { method: "POST", signal });
    const prepared = prepareGatewayRequest(env, config, TEST_IDENTITY, "chat", sent, {
      model, stream: false, [capField]: 32, messages: [{ role: "user", content: "Reply with the single word OK." }]
    });
    return callGatewayUpstream(env, "chat", sent, prepared, prepared.body, ctx);
  };
  const done = (fields: Record<string, unknown>) =>
    Response.json({ model, latency_ms: Date.now() - started, ...fields }, { headers: { "cache-control": "no-store" } });
  try {
    let response = await attempt("max_tokens");
    let text = await response.text();
    // OpenAI's reasoning models answer a max_tokens request with "use max_completion_tokens instead".
    if (response.status === 400 && /max_completion_tokens/i.test(text)) {
      response = await attempt("max_completion_tokens");
      text = await response.text();
    }
    if (!response.ok) return done({ ok: false, status: response.status, error: refusalText(text) || `HTTP ${response.status}` });
    let reply: unknown;
    try {
      const data = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] };
      if (!Array.isArray(data.choices)) return done({ ok: false, status: response.status, error: "The upstream answered, but not with a chat completion." });
      reply = data.choices[0]?.message?.content;
    } catch { return done({ ok: false, status: response.status, error: "The upstream answered, but not with JSON." }); }
    return done({ ok: true, status: response.status, reply: typeof reply === "string" ? reply.trim().slice(0, 80) : "" });
  } catch (error) {
    const timedOut = signal.aborted && !request.signal.aborted;
    return done({ ok: false, status: 0, error: timedOut ? `No answer within ${TEST_TIMEOUT_MS / 1000} seconds.` : refusalText(error instanceof Error ? error.message : String(error)) });
  }
}
