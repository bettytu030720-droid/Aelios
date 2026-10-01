// 候选由谁来审：先让这个空间的助手自己判——用它最近真正在说话的那个主模型，
// 走和聊天同一条上游路线 (网关只记主模型的往来，和聊天原文同一个保留期)；
// 认不出它的模型时，才交给 JUDGE_MODEL / DREAM_MODEL 代审。

import {
  identityNamespace,
  isMainModel,
  loadConfig,
  object,
  PROTOCOLS,
  type GatewayConfig,
  type Identity,
  type Protocol
} from "../gateway/config";
import { visibleText } from "../gateway/protocol";
import { resolveUpstream, routeFor } from "../gateway/upstream";
import type { Env } from "../types";
import { ModelCallError, readModelName } from "../utils/modelCall";

export type JudgeVoice =
  | { kind: "self"; name: string; config: GatewayConfig; identity: Identity; protocol: Protocol; model: string }
  | { kind: "shared"; model: string };

// 推理模型的思考也算输出额度，给少了只会拿回一个被截断的空答案；实际只按用掉的计费。
const SELF_JUDGE_MAX_TOKENS = 8000;
const SELF_JUDGE_TIMEOUT_MS = 120_000;
const RECENT_EXCHANGES = 20;

export function assistantLabel(identity: Identity): string {
  return identity.assistantName?.trim() || identity.slug;
}

/** Anthropic answers with the bare model id; the recorded provider header restores the author prefix routing needs. */
export function callableModelName(model: string | null | undefined, provider: string | null | undefined): string | null {
  const name = (model ?? "").trim();
  if (!name) return null;
  if (name.includes("/")) return name;
  const author = (provider ?? "").trim().toLowerCase();
  return author ? `${author}/${name}` : null;
}

export async function resolveJudgeVoice(env: Env, namespace: string): Promise<JudgeVoice | null> {
  let config: GatewayConfig | null = null;
  try {
    config = await loadConfig(env);
  } catch (error) {
    console.error("candidate judge: gateway config unreadable, using the shared judge", { namespace, error });
  }
  const identities = config
    ? config.identities.filter((identity) => identity.models.length > 0 && identityNamespace(identity) === namespace)
    : [];

  if (config && identities.length > 0) {
    // 最近开口的那位助手来判：填了审核模型就用它 (走 chat)，否则用它这次说话的主模型和协议。
    try {
      const rows = await env.DB.prepare(
        `SELECT profile, protocol, upstream_model, upstream_provider
         FROM gateway_exchanges
         WHERE namespace = ? AND kind != 'auxiliary' AND completion_status = 'complete'
         ORDER BY created_at DESC
         LIMIT ?`
      )
        .bind(namespace, RECENT_EXCHANGES)
        .all<{ profile: string; protocol: string; upstream_model: string; upstream_provider: string }>();
      for (const row of rows.results ?? []) {
        const identity = identities.find((item) => item.slug === row.profile);
        if (!identity) continue;
        const pinned = identity.judgeModel?.trim();
        if (pinned) return { kind: "self", name: assistantLabel(identity), config, identity, protocol: "chat", model: pinned };
        const model = callableModelName(row.upstream_model, row.upstream_provider);
        const protocol = PROTOCOLS.find((item) => item === row.protocol);
        if (!model || !protocol || !isMainModel(identity, model)) continue;
        return { kind: "self", name: assistantLabel(identity), config, identity, protocol, model };
      }
    } catch (error) {
      console.error("candidate judge: recent exchanges unreadable", { namespace, error });
    }

    // 聊天记录保留期内没人开口：有填审核模型的助手照样自己判。
    const pinned = identities.find((identity) => identity.judgeModel?.trim());
    if (pinned?.judgeModel) {
      return { kind: "self", name: assistantLabel(pinned), config, identity: pinned, protocol: "chat", model: pinned.judgeModel.trim() };
    }
  }

  const shared = readModelName(env, ["JUDGE_MODEL", "DREAM_MODEL"], "");
  return shared ? { kind: "shared", model: shared } : null;
}

function replyText(protocol: Protocol, data: unknown): string {
  if (!object(data)) return "";
  if (protocol === "messages") {
    const blocks = Array.isArray(data.content) ? data.content : [];
    return blocks
      .filter((block: unknown) => object(block) && block.type === "text" && typeof block.text === "string")
      .map((block: { text: string }) => block.text)
      .join("\n")
      .trim();
  }
  if (protocol === "responses") {
    const items = Array.isArray(data.output) ? data.output : [];
    const text = items
      .filter((item: unknown) => object(item) && item.type === "message")
      .map((item: { content?: unknown }) => visibleText(item.content))
      .join("\n")
      .trim();
    return text || (typeof data.output_text === "string" ? data.output_text.trim() : "");
  }
  const message = data.choices?.[0]?.message;
  const content = visibleText(message?.content).trim();
  return content || (typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "");
}

/** One call through the same upstream route the assistant chats on. Throws on a non-ok answer or timeout. */
export async function askOwnModel(
  env: Env,
  voice: Extract<JudgeVoice, { kind: "self" }>,
  input: { system: string; prompt: string }
): Promise<string> {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new ModelCallError("Missing Worker secret CLOUDFLARE_API_TOKEN");
  const route = routeFor(resolveUpstream(env, voice.config), voice.protocol, voice.model);
  const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
  headers.set(route.auth === "cf-aig" ? "cf-aig-authorization" : "authorization", `Bearer ${token}`);

  let body: Record<string, unknown>;
  if (voice.protocol === "messages") {
    headers.set("anthropic-version", "2023-06-01");
    body = {
      model: route.model,
      system: input.system,
      messages: [{ role: "user", content: input.prompt }],
      max_tokens: SELF_JUDGE_MAX_TOKENS,
      stream: false
    };
  } else if (voice.protocol === "responses") {
    body = {
      model: route.model,
      instructions: input.system,
      input: input.prompt,
      max_output_tokens: SELF_JUDGE_MAX_TOKENS,
      store: false,
      stream: false
    };
  } else {
    body = {
      model: route.model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt }
      ],
      max_tokens: SELF_JUDGE_MAX_TOKENS,
      stream: false
    };
  }

  const response = await fetch(route.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SELF_JUDGE_TIMEOUT_MS)
  });
  if (!response.ok) throw new ModelCallError(`judge model returned status ${response.status}`, response.status);
  return replyText(voice.protocol, await response.json());
}
