// Aelios's own background calls (Dream, diary, roll-ups, trigger building, the guide-dog) all go through
// callOpenAICompat with a chat-shaped request. A model named `chatgpt/<model>` there runs on the same ChatGPT
// plan route as a client's request, so the nightly jobs can use the plan too. The answer comes back as the
// chat.completion those callers already read; a failure comes back as the same `{error:{message}}` body.
import type { Env, OpenAIChatRequest } from "../types";
import type { Body } from "../gateway/protocol";
import { MODEL_PREFIX, type WaitUntil } from "./client";
import { callChatGptUpstream } from "./upstream";

export function isChatGptModel(model: unknown): model is string {
  return typeof model === "string" && model.trim().toLowerCase().startsWith(MODEL_PREFIX);
}

/** `waitUntil`, when the caller has one, keeps a token refresh alive past a client that hangs up. */
export function callChatGptChat(env: Env, body: OpenAIChatRequest, waitUntil?: WaitUntil, signal?: AbortSignal): Promise<Response> {
  const requested = body.model.trim();
  return callChatGptUpstream(env, "chat", signal,
    { model: requested.slice(MODEL_PREFIX.length).trim(), requestedModel: requested, removed: [] }, body as unknown as Body, waitUntil);
}
