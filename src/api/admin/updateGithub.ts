import { object } from "../../gateway/config";

export const UPSTREAM = "Aelios-project/Aelios";

export class GitHubError extends Error {
  constructor(readonly status: number, readonly rateLimited: boolean) {
    super("GitHub request failed");
  }
}

export async function githubRequest(path: string, token?: string, post?: { body?: object }): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: post ? "POST" : "GET",
    headers: {
      "accept": "application/vnd.github+json",
      "user-agent": "Aelios-updater",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(post?.body ? { "content-type": "application/json" } : {})
    },
    body: post?.body ? JSON.stringify(post.body) : undefined,
    signal: AbortSignal.timeout(8_000),
    redirect: "manual"
  });
  if (!response.ok) {
    throw new GitHubError(response.status, response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.has("retry-after"));
  }
  const data: unknown = await response.json();
  if (!object(data)) throw new Error("Invalid response from GitHub");
  return data;
}

export function githubId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}

export async function forkRepository(repo: string, token?: string) {
  const data = await githubRequest(`/repos/${repo}`, token);
  if (data.fork !== true || !object(data.parent) || typeof data.parent.full_name !== "string" ||
    data.parent.full_name.toLowerCase() !== UPSTREAM.toLowerCase() || !githubId(data.id) ||
    !object(data.owner) || !githubId(data.owner.id) || !["User", "Organization"].includes(String(data.owner.type))) return null;
  return { id: data.id, ownerId: data.owner.id, organization: data.owner.type === "Organization" };
}
