import { authenticate } from "../auth/apiKey";
import type { Env } from "../types";
import { json, openAiError } from "../utils/json";
import { findIdentity, loadConfig, type GatewayConfig } from "../gateway/config";
import { catalogUrl } from "../gateway/upstream";
import { ownerOnly } from "../gateway/admin";
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

/** One line of the owner's model list, in the shape /v1/models gives its entries. */
function listedEntry(id: string, fallbackOwner: string): Record<string, unknown> {
  const slash = id.indexOf("/");
  return { id, object: "model", created: 0, owned_by: slash > 0 ? id.slice(0, slash) : fallbackOwner };
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
    return json({ object: "list", data: config.modelList.map(id => listedEntry(id, identity.slug)) },
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
