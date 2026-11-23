import { authenticate } from "../../auth/apiKey";
import { object } from "../../gateway/config";
import type { Env } from "../../types";
import { json } from "../../utils/json";

const UPSTREAM = "Aelios-project/Aelios";
const DEPLOY_BRANCH = "main";
const START_TIMEOUT = 90_000;
const BUILD_TIMEOUT = 25 * 60_000;
const VERSION_CACHE_SECONDS = 180;

type Settings = { current: string; repo: string; worker: string; deployment: string; token: string; deployHook: string | null };
type Attempt = {
  attempt_id: string;
  start_commit: string;
  target_commit: string | null;
  started_at: number;
  hook_started_at: number | null;
  failure: string | null;
};
type Build = { status: string; conclusion?: string; completed_at?: string | null; details_url?: string };
type UpdateStatus = {
  state: "off" | "current" | "available" | "unavailable" | "starting" | "deploying" | "failed";
  current?: string;
  target?: string;
  reason?: string;
  buildUrl?: string;
};

class UpdateFailure extends Error {}

function sha(value: unknown): string | null {
  return typeof value === "string" && /^[a-f\d]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function deployHookUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin === "https://api.cloudflare.com" && !url.username && !url.password && !url.search && !url.hash &&
      /^\/client\/v4\/workers\/builds\/deploy_hooks\/[a-z\d_-]{16,128}$/i.test(url.pathname)) return url.href;
  } catch { /* an invalid deployment variable leaves retries unavailable */ }
  return null;
}

function settings(env: Env): Settings | null {
  const current = sha(env.AELIOS_BUILD_COMMIT);
  const repo = env.AELIOS_BUILD_REPO?.trim() || env.AELIOS_UPDATE_REPO?.trim();
  const worker = env.AELIOS_BUILD_WORKER?.trim();
  const token = env.AELIOS_UPDATE_GITHUB_TOKEN?.trim();
  if (!current || !repo || !worker || !token || !/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(repo) ||
    repo.toLowerCase() === UPSTREAM.toLowerCase()) return null;
  const deployment = `${repo.toLowerCase()}:${worker}`;
  return { current, repo, worker, deployment, token, deployHook: deployHookUrl(env.AELIOS_UPDATE_DEPLOY_HOOK) };
}

async function github(config: Settings, path: string, body?: { branch: string }): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "authorization": `Bearer ${config.token}`,
      "accept": "application/vnd.github+json",
      "user-agent": "Aelios-updater",
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8_000),
    redirect: "error"
  });
  if (!response.ok) {
    if (body && response.status === 409) throw new UpdateFailure("merge_conflict");
    if (body && response.status === 422) throw new UpdateFailure("sync_rejected");
    if ([401, 403].includes(response.status) && response.headers.get("x-ratelimit-remaining") !== "0") {
      throw new UpdateFailure("github_permission");
    }
    throw new UpdateFailure("github_unavailable");
  }
  const data: unknown = await response.json();
  if (!object(data)) throw new UpdateFailure("github_unavailable");
  return data;
}

async function branchCommit(config: Settings, repo: string): Promise<string> {
  const data = await github(config, `/repos/${repo}/git/ref/heads/${DEPLOY_BRANCH}`);
  const commit = object(data.object) ? sha(data.object.sha) : null;
  if (!commit) throw new UpdateFailure("github_unavailable");
  return commit;
}

async function isBehind(config: Settings): Promise<boolean> {
  const latest = await branchCommit(config, UPSTREAM);
  if (latest === config.current) return false;
  const upstreamOwner = UPSTREAM.split("/")[0];
  // GitHub includes file diffs only on the first page. Later pages still provide ahead_by.
  const result = await github(config, `/repos/${config.repo}/compare/${config.current}...${upstreamOwner}:${latest}?per_page=1&page=2`);
  if (typeof result.ahead_by !== "number") throw new UpdateFailure("github_unavailable");
  return result.ahead_by > 0;
}

async function available(request: Request, ctx: ExecutionContext, config: Settings): Promise<boolean> {
  const cache = typeof caches === "undefined" ? undefined : caches.default;
  const cacheKey = new Request(new URL(`/__aelios/deployment-update/${config.current}`, request.url));
  const cached = await cache?.match(cacheKey).catch(() => undefined);
  if (cached) return await cached.text() === "behind";
  const behind = await isBehind(config);
  if (cache) {
    ctx.waitUntil(cache.put(cacheKey, new Response(behind ? "behind" : "current", {
      headers: { "cache-control": `public, max-age=${VERSION_CACHE_SECONDS}` }
    })).catch(() => {}));
  }
  return behind;
}

async function latestBuild(config: Settings, target: string): Promise<Build | undefined> {
  // Match this Worker's check. The Worker that answers the status request confirms deployment.
  const name = `Workers Builds: ${config.worker}`;
  const params = new URLSearchParams({ check_name: name, filter: "latest", per_page: "20" });
  const data = await github(config, `/repos/${config.repo}/commits/${target}/check-runs?${params}`);
  if (!Array.isArray(data.check_runs)) throw new UpdateFailure("github_unavailable");
  return data.check_runs.find(run => object(run) && run.name === name && run.head_sha === target &&
    object(run.app) && run.app.slug === "cloudflare-workers-and-pages" && typeof run.status === "string");
}

function buildLink(build: Build | undefined): string | undefined {
  try {
    const url = new URL(build?.details_url ?? "");
    return url.origin === "https://dash.cloudflare.com" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

async function attemptStatus(config: Settings, attempt: Attempt | null): Promise<UpdateStatus | null> {
  if (!attempt || attempt.start_commit !== config.current) return null;
  const elapsed = Date.now() - attempt.started_at;
  if (attempt.failure) return { state: "failed", reason: attempt.failure };
  if (!attempt.target_commit) {
    return elapsed < START_TIMEOUT ? { state: "starting" } : { state: "failed", reason: "start_timeout" };
  }
  const target = attempt.target_commit;
  const build = await latestBuild(config, target).catch(() => undefined);
  const buildUrl = buildLink(build);
  // A manual retry can leave the previous failed check visible until the new build reports.
  const fromThisBuild = Date.parse(build?.completed_at ?? "") >= (attempt.hook_started_at ?? attempt.started_at);
  if (fromThisBuild && build?.status === "completed" && build.conclusion && build.conclusion !== "success") {
    return { state: "failed", target, buildUrl, reason: "build_failed" };
  }
  if (elapsed >= BUILD_TIMEOUT) return { state: "failed", target, buildUrl, reason: "build_timeout" };
  return { state: "deploying", target, buildUrl,
    ...(fromThisBuild && build?.status === "completed" && build.conclusion === "success" ? { reason: "awaiting_live_commit" } : {}) };
}

async function triggerBuild(config: Settings): Promise<void> {
  if (!config.deployHook) throw new UpdateFailure("deploy_hook_required");
  const response = await fetch(config.deployHook, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new UpdateFailure("deploy_hook_failed");
  const data: unknown = await response.json();
  if (!object(data) || data.success !== true || !object(data.result) || typeof data.result.build_uuid !== "string" ||
    (data.result.branch && data.result.branch !== DEPLOY_BRANCH) ||
    (data.result.worker && data.result.worker !== config.worker)) throw new UpdateFailure("deploy_hook_failed");
}

async function startUpdate(env: Env, config: Settings, previous: Attempt | null): Promise<UpdateStatus> {
  if (!await isBehind(config)) return { state: "current" };
  const fork = await github(config, `/repos/${config.repo}`);
  if (fork.fork !== true || !object(fork.parent) || typeof fork.parent.full_name !== "string" ||
    fork.parent.full_name.toLowerCase() !== UPSTREAM.toLowerCase()) throw new UpdateFailure("fork_required");
  const id = crypto.randomUUID();
  const start = Date.now();
  const claimed = await env.DB.prepare(`INSERT INTO admin_deployment_update (deployment, attempt_id, start_commit, started_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(deployment) DO UPDATE SET
    attempt_id=excluded.attempt_id, start_commit=excluded.start_commit, started_at=excluded.started_at,
    target_commit=NULL, hook_started_at=NULL, failure=NULL WHERE attempt_id=?`)
    .bind(config.deployment, id, config.current, start, previous?.attempt_id ?? null).run();
  if (!claimed.meta.changes) return { state: "starting" };

  try {
    const merged = await github(config, `/repos/${config.repo}/merge-upstream`, { branch: DEPLOY_BRANCH });
    if (!["merge", "fast-forward", "none"].includes(String(merged.merge_type))) throw new UpdateFailure("github_unavailable");
    const target = await branchCommit(config, config.repo);
    if (target === config.current) throw new UpdateFailure("sync_incomplete");
    let hookStartedAt = null;
    if (merged.merge_type === "none") {
      const build = await latestBuild(config, target);
      const recentlySuccessful = build?.conclusion === "success" &&
        start - Date.parse(build.completed_at ?? "") < START_TIMEOUT;
      if ((!build || build.status === "completed") && !recentlySuccessful) {
        hookStartedAt = Date.now();
        await triggerBuild(config);
      }
    }
    await env.DB.prepare("UPDATE admin_deployment_update SET target_commit=?, hook_started_at=? WHERE deployment=? AND attempt_id=?")
      .bind(target, hookStartedAt, config.deployment, id).run();
    return { state: "deploying", target };
  } catch (error) {
    const reason = error instanceof UpdateFailure ? error.message : "update_unavailable";
    await env.DB.prepare("UPDATE admin_deployment_update SET failure=? WHERE deployment=? AND attempt_id=?")
      .bind(reason, config.deployment, id).run();
    return { state: "failed", reason };
  }
}

export async function handleDeploymentUpdate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  const auth = await authenticate(request, env);
  if (!auth.ok || auth.keyName !== "CHATBOX_API_KEY") return json({ error: "Main key required" }, { status: 401, headers });
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "Use GET or POST" }, { status: 405, headers: { ...headers, allow: "GET, POST" } });
  }
  const config = settings(env);
  if (!config) return json({ state: "off" }, { headers });
  const reply = (status: UpdateStatus) => json({ ...status, current: config.current }, { headers });
  try {
    const attempt = await env.DB.prepare("SELECT * FROM admin_deployment_update WHERE deployment=?")
      .bind(config.deployment).first<Attempt>();
    const status = await attemptStatus(config, attempt);
    if (request.method === "GET") {
      if (status && status.state !== "failed") return reply(status);
      return reply(await available(request, ctx, config) ? (status ?? { state: "available" }) : { state: "current" });
    }
    if (status?.state === "starting" || status?.state === "deploying") return reply(status);
    return reply(await startUpdate(env, config, attempt));
  } catch (error) {
    return reply(request.method === "POST"
      ? { state: "failed", reason: error instanceof UpdateFailure ? error.message : "update_unavailable" }
      : { state: "unavailable" });
  }
}
