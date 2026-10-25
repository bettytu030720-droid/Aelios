import { authenticate } from "../auth/apiKey";
import type { Env } from "../types";
import { json, openAiError } from "../utils/json";
import { findIdentity, loadConfig, type GatewayConfig } from "../gateway/config";
import { catalogUrl } from "../gateway/upstream";
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

/** The upstream owns the real catalog; local main models are only hints when it cannot answer. */
export async function handleModels(request: Request, env: Env, slug: string | null = null, ctx?: ExecutionContext): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  let config: GatewayConfig;
  try { config = await loadConfig(env); }
  catch { return openAiError("Gateway configuration unavailable. Apply migrations.", 503); }

  const identity = findIdentity(config, auth, slug);
  if (!identity) return openAiError("No identity available for this key. Configure /admin.", 403);

  const chatgpt = chatGptEntries(env, request.signal, ctx);
  // The catalog lives on the AI Gateway compat surface; CF REST has no GET /models (405).
  const token = env.CLOUDFLARE_API_TOKEN;
  const address = config.upstream?.address?.trim() || env.AI_GATEWAY_BASE_URL || env.CLOUDFLARE_ACCOUNT_ID || "";
  let reason = !token ? "no-token" : !address ? "no-address" : "";
  if (!reason) {
    const url = catalogUrl(env, config);
    try {
      const upstream = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: request.signal });
      if (upstream.ok) {
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
      reason = `upstream-${upstream.status}`;
    } catch { reason = "upstream-error"; }
  }
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
