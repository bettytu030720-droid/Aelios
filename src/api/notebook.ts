import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import {
  clearNotebook,
  deleteNotebookPageById,
  getNotebookPageById,
  listNotebookPages,
  NotebookError,
  updateNotebookPage,
  writeNotebookPage
} from "../db/v2";
import type { Env } from "../types";
import { json, openAiError } from "../utils/json";
import { readJsonObject, readString, resolveNamespace } from "../utils/request";

// 小本本：面板「更多 → 小本本」用。MCP 那边是 notebook 工具，按页名读写；这里按 id。
export async function handleNotebookApi(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];

  if (request.method === "GET") {
    const scopeError = requireScope(auth.profile, "memory:read");
    if (scopeError) return scopeError;
    if (!id) return json({ data: await listNotebookPages(env.DB, { namespace }) });
    const page = await getNotebookPageById(env.DB, { namespace, id });
    if (!page) return openAiError("Notebook page not found", 404);
    return json({ data: page });
  }

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  try {
    if (request.method === "POST" && !id) {
      const body = await readJsonObject(request);
      if (!body) return openAiError("Request body must be a JSON object", 400);
      const name = readString(body.name);
      const content = readString(body.content);
      if (!name || !content) return openAiError("name and content are required", 400);
      const { page, created } = await writeNotebookPage(env.DB, {
        namespace: resolveNamespace(auth.profile, body.namespace ?? url.searchParams.get("namespace")),
        name,
        content
      });
      return json({ data: page, created }, { status: created ? 201 : 200 });
    }

    if (request.method === "PATCH" && id) {
      const body = await readJsonObject(request);
      if (!body) return openAiError("Request body must be a JSON object", 400);
      const page = await updateNotebookPage(env.DB, {
        namespace: resolveNamespace(auth.profile, body.namespace ?? url.searchParams.get("namespace")),
        id,
        name: readString(body.name),
        content: readString(body.content)
      });
      if (!page) return openAiError("Notebook page not found", 404);
      return json({ data: page });
    }
  } catch (error) {
    if (error instanceof NotebookError) return openAiError(error.message, 400);
    throw error;
  }

  if (request.method === "DELETE" && id) {
    const deleted = await deleteNotebookPageById(env.DB, { namespace, id });
    if (!deleted) return openAiError("Notebook page not found", 404);
    return json({ data: { id, deleted: true } });
  }

  // 全部清空要带 ?confirm=all，免得一个空 DELETE 把整本删了。
  if (request.method === "DELETE" && !id) {
    if (url.searchParams.get("confirm") !== "all") {
      return openAiError("Add ?confirm=all to delete every notebook page in this space", 400);
    }
    return json({ data: { deleted: await clearNotebook(env.DB, { namespace }) } });
  }

  return openAiError("Not found", 404);
}
