import { authenticate } from "../../auth/apiKey";
import { object } from "../../gateway/config";
import type { Env } from "../../types";
import { json } from "../../utils/json";
import { sealSecret, unsealSecret } from "../../utils/sealedSecret";
import { forkRepository, GitHubError, githubRequest, UPSTREAM } from "./updateGithub";
import { handleGitHubConnect, installedGitHubApp, mintGitHubUpdateToken } from "./updateGithubApp";

const DEPLOY_BRANCH = "main";
const START_TIMEOUT = 90_000;
const BUILD_TIMEOUT = 25 * 60_000;
const VERSION_CACHE_SECONDS = 180;

type Settings = { current: string; repo: string; worker: string; deployment: string; token?: string; deployHook: string | null };
type Attempt = {
  attempt_id: string;
  start_commit: string;
  target_commit: string | null;
  started_at: number;
  hook_started_at: number | null;
  failure: string | null;
  github_token_enc: string | null;
};
type Build = { status: string; conclusion?: string; completed_at?: string | null; details_url?: string };
type UpdateStatus = {
  state: "off" | "current" | "available" | "connect" | "unavailable" | "starting" | "deploying" | "failed";
  current?: string;
  target?: string;
  reason?: string;
  buildUrl?: string;
  repo?: string;
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
  const token = env.AELIOS_UPDATE_GITHUB_TOKEN?.trim() || undefined;
  if (!current || !repo || !worker || !/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(repo) ||
    repo.toLowerCase() === UPSTREAM.toLowerCase()) return null;
  const deployment = `${repo.toLowerCase()}:${worker}`;
  return { current, repo, worker, deployment, token, deployHook: deployHookUrl(env.AELIOS_UPDATE_DEPLOY_HOOK) };
}

async function github(config: Settings, path: string, body?: { branch: string }): Promise<Record<string, unknown>> {
  try {
    return await githubRequest(path, config.token, body ? { body } : undefined);
  } catch (error) {
    if (error instanceof GitHubError && !error.rateLimited) {
      if (body && error.status === 409) throw new UpdateFailure("merge_conflict");
      if (body && error.status === 422) throw new UpdateFailure("sync_rejected");
      if ([401, 403].includes(error.status)) throw new UpdateFailure("github_permission");
    }
    throw new UpdateFailure("github_unavailable");
  }
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
  const cacheKey = new Request(new URL(`/__aelios/deployment-update/${config.repo.toLowerCase()}/${config.current}`, request.url));
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

function buildTokenContext(config: Settings, attemptId: string): string {
  return `aelios.github-update-build.v1:${config.deployment}:${attemptId}`;
}

async function attemptStatus(config: Settings, key: string, attempt: Attempt | null): Promise<UpdateStatus | null> {
  if (!attempt || attempt.start_commit !== config.current) return null;
  const elapsed = Date.now() - attempt.started_at;
  if (attempt.failure) return { state: "failed", reason: attempt.failure };
  if (!attempt.target_commit) {
    return elapsed < START_TIMEOUT ? { state: "starting" } : { state: "failed", reason: "start_timeout" };
  }
  const target = attempt.target_commit;
  const token = config.token ??
    await unsealSecret(key, buildTokenContext(config, attempt.attempt_id), attempt.github_token_enc) ?? undefined;
  const build = await latestBuild({ ...config, token }, target).catch(() => undefined);
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
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new UpdateFailure("deploy_hook_failed");
  const data: unknown = await response.json();
  if (!object(data) || data.success !== true || !object(data.result) || typeof data.result.build_uuid !== "string" ||
    (data.result.branch && data.result.branch !== DEPLOY_BRANCH) ||
    (data.result.worker && data.result.worker !== config.worker)) throw new UpdateFailure("deploy_hook_failed");
}

function connectStatus(config: Settings): UpdateStatus {
  return { state: "connect", repo: config.repo };
}

async function startUpdate(env: Env, config: Settings, key: string, previous: Attempt | null): Promise<UpdateStatus> {
  if (!await isBehind(config)) return { state: "current" };
  const fork = await forkRepository(config.repo, config.token);
  if (!fork) throw new UpdateFailure("fork_required");
  const app = config.token ? null : await installedGitHubApp(env, key, config);
  if (!config.token && (!app || app.repository_id !== fork.id || app.owner_id !== fork.ownerId)) return connectStatus(config);
  const id = crypto.randomUUID();
  const start = Date.now();
  const claimed = await env.DB.prepare(`INSERT INTO admin_deployment_update (deployment, attempt_id, start_commit, started_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(deployment) DO UPDATE SET
    attempt_id=excluded.attempt_id, start_commit=excluded.start_commit, started_at=excluded.started_at,
    target_commit=NULL, hook_started_at=NULL, failure=NULL, github_token_enc=NULL WHERE attempt_id=?`)
    .bind(config.deployment, id, config.current, start, previous?.attempt_id ?? null).run();
  if (!claimed.meta.changes) return { state: "starting" };

  try {
    const token = app ? await mintGitHubUpdateToken(env, config, app) : config.token;
    if (!token) throw new UpdateFailure("github_connect_required");
    const authenticated = { ...config, token };
    const sealed = app ? await sealSecret(key, buildTokenContext(config, id), token) : null;
    const merged = await github(authenticated, `/repos/${config.repo}/merge-upstream`, { branch: DEPLOY_BRANCH });
    if (!["merge", "fast-forward", "none"].includes(String(merged.merge_type))) throw new UpdateFailure("github_unavailable");
    const target = await branchCommit(authenticated, config.repo);
    if (target === config.current) throw new UpdateFailure("sync_incomplete");
    let hookStartedAt = null;
    if (merged.merge_type === "none") {
      const build = await latestBuild(authenticated, target);
      const recentlySuccessful = build?.conclusion === "success" &&
        start - Date.parse(build.completed_at ?? "") < START_TIMEOUT;
      if ((!build || build.status === "completed") && !recentlySuccessful) {
        hookStartedAt = Date.now();
        await triggerBuild(config);
      }
    }
    await env.DB.prepare(`UPDATE admin_deployment_update SET target_commit=?, hook_started_at=?, github_token_enc=?
      WHERE deployment=? AND attempt_id=?`).bind(target, hookStartedAt, sealed, config.deployment, id).run();
    return { state: "deploying", target };
  } catch (error) {
    const reason = error instanceof UpdateFailure ? error.message : "update_unavailable";
    await env.DB.prepare("UPDATE admin_deployment_update SET failure=? WHERE deployment=? AND attempt_id=?")
      .bind(reason, config.deployment, id).run();
    return reason === "github_connect_required" ? connectStatus(config) : { state: "failed", reason };
  }
}

export async function handleDeploymentUpdate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const config = settings(env);
  if (new URL(request.url).pathname !== "/api/admin/update") return handleGitHubConnect(request, env, config);
  const headers = { "cache-control": "no-store" };
  const auth = await authenticate(request, env);
  const key = env.CHATBOX_API_KEY;
  if (!key || !auth.ok || auth.keyName !== "CHATBOX_API_KEY") return json({ error: "Main key required" }, { status: 401, headers });
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "Use GET or POST" }, { status: 405, headers: { ...headers, allow: "GET, POST" } });
  }
  if (!config) return json({ state: "off" }, { headers });
  const reply = (status: UpdateStatus) => json({ ...status, current: config.current }, { headers });
  try {
    const attempt = await env.DB.prepare("SELECT * FROM admin_deployment_update WHERE deployment=?")
      .bind(config.deployment).first<Attempt>();
    const status = await attemptStatus(config, key, attempt);
    if (request.method === "GET") {
      if (status && status.state !== "failed") return reply(status);
      if (!await available(request, ctx, config)) return reply({ state: "current" });
      if (!config.token && !await installedGitHubApp(env, key, config)) {
        return reply(await forkRepository(config.repo) ? connectStatus(config) : { state: "off" });
      }
      return reply(status && status.reason !== "github_connect_required" ? status : { state: "available" });
    }
    if (status?.state === "starting" || status?.state === "deploying") return reply(status);
    return reply(await startUpdate(env, config, key, attempt));
  } catch (error) {
    return reply(request.method === "POST"
      ? { state: "failed", reason: error instanceof UpdateFailure ? error.message : "update_unavailable" }
      : { state: "unavailable" });
  }
}
