import { authenticate } from "../../auth/apiKey";
import { object } from "../../gateway/config";
import type { Env } from "../../types";
import { b64url, fromB64url, randomToken } from "../../utils/base64";
import { json } from "../../utils/json";
import { sealSecret, unsealSecret } from "../../utils/sealedSecret";
import { forkRepository, GitHubError, githubId, githubRequest } from "./updateGithub";

const GITHUB_CONNECT_PATH = "/api/admin/update/connect";
const REGISTERED_PATH = `${GITHUB_CONNECT_PATH}/registered`;
const INSTALLED_PATH = `${GITHUB_CONNECT_PATH}/installed`;
const COOKIE = "__Host-aelios-update";
const SETUP_SECONDS = 3600;
const permissions = { contents: "write", checks: "read", workflows: "write" };
const noStore = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

type Source = { deployment: string; repo: string };
type App = { id: number; client_id: string; slug: string; pem: string };
type Connection = {
  repository_id: number;
  owner_id: number;
  state: string | null;
  browser_proof: string | null;
  expires_at: number;
  app_enc: string | null;
  installation_id: number | null;
};
type InstalledApp = {
  app: App;
  app_enc: string;
  installation_id: number;
  repository_id: number;
  owner_id: number;
};

function appFrom(value: unknown): App | null {
  if (!object(value) || !githubId(value.id) || typeof value.client_id !== "string" ||
    typeof value.slug !== "string" || !/^[a-z0-9-]+$/.test(value.slug) || typeof value.pem !== "string") return null;
  return { id: value.id, client_id: value.client_id, slug: value.slug, pem: value.pem };
}

function appContext(source: Source): string {
  return `aelios.github-update.v1:${source.deployment}`;
}

function connection(env: Env, source: Source): Promise<Connection | null> {
  return env.DB.prepare("SELECT * FROM admin_deployment_github WHERE deployment=?")
    .bind(source.deployment).first<Connection>();
}

async function openApp(key: string, source: Source, row: Connection | null): Promise<App | null> {
  const plain = await unsealSecret(key, appContext(source), row?.app_enc ?? null);
  return plain ? appFrom(JSON.parse(plain)) : null;
}

export async function installedGitHubApp(env: Env, key: string, source: Source): Promise<InstalledApp | null> {
  const row = await connection(env, source);
  if (!row?.installation_id || !row.app_enc) return null;
  const app = await openApp(key, source, row);
  return app ? { ...row, app, app_enc: row.app_enc, installation_id: row.installation_id } : null;
}

// GitHub returns RSA keys in PKCS#1 PEM. Wrap the DER payload as PKCS#8 for Web Crypto.
function der(tag: number, bytes: Uint8Array): Uint8Array {
  const size = bytes.length;
  const length = size < 128 ? [size] : size < 256 ? [0x81, size] : [0x82, size >> 8, size & 0xff];
  return Uint8Array.of(tag, ...length, ...bytes);
}

async function appJwt(app: App): Promise<string> {
  const pem = app.pem.trim();
  let key = fromB64url(pem.replace(/-----[^-]+-----|\s/g, ""));
  if (pem.startsWith("-----BEGIN RSA PRIVATE KEY-----")) {
    const rsa = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
    key = der(0x30, Uint8Array.of(0x02, 0x01, 0x00, ...rsa, ...der(0x04, key)));
  }
  const signingKey = await crypto.subtle.importKey("pkcs8", key, {
    name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"
  }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const header = b64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64url(encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.client_id })));
  const payload = `${header}.${claims}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, encoder.encode(payload));
  return `${payload}.${b64url(new Uint8Array(signature))}`;
}

async function repoInstallation(app: App, source: Source, ownerId: number): Promise<number | null> {
  const jwt = await appJwt(app);
  try {
    const data = await githubRequest(`/repos/${source.repo}/installation`, jwt);
    if (!githubId(data.id) || data.app_id !== app.id || !object(data.account) || data.account.id !== ownerId ||
      data.suspended_at || !object(data.permissions) || data.permissions.contents !== "write" ||
      data.permissions.workflows !== "write" || !["read", "write"].includes(data.permissions.checks)) return null;
    return data.id;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
}

export async function mintGitHubUpdateToken(env: Env, source: Source, current: InstalledApp): Promise<string | null> {
  const jwt = await appJwt(current.app);
  try {
    const data = await githubRequest(`/app/installations/${current.installation_id}/access_tokens`, jwt, {
      body: { repository_ids: [current.repository_id], permissions }
    });
    if (typeof data.token !== "string" || !data.token) throw new Error("GitHub returned no installation token");
    return data.token;
  } catch (error) {
    if (!(error instanceof GitHubError) || error.rateLimited || ![401, 403, 404, 422].includes(error.status)) throw error;
    await env.DB.prepare("UPDATE admin_deployment_github SET installation_id=NULL WHERE deployment=? AND app_enc=? AND installation_id=?")
      .bind(source.deployment, current.app_enc, current.installation_id).run();
    return null;
  }
}

function cookie(value: string, age: number): string {
  return `${COOKIE}=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`;
}

async function browserProof(key: string, browser: string): Promise<Uint8Array> {
  const input = new TextEncoder().encode(JSON.stringify(["aelios.github-update.browser.v1", browser, key]));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

function installUrl(app: App, state: string): string {
  return `https://github.com/apps/${app.slug}/installations/new?state=${state}`;
}

async function begin(request: Request, env: Env, key: string, source: Source): Promise<Response> {
  const origin = new URL(request.url).origin;
  if (!origin.startsWith("https://") || request.headers.get("origin") !== origin) {
    return json({ error: "Open the Worker’s HTTPS admin to connect GitHub" }, { status: 403, headers: noStore });
  }
  const fork = await forkRepository(source.repo);
  if (!fork) return json({ error: "An Aelios fork is required" }, { status: 409, headers: noStore });

  const previous = await connection(env, source);
  const sameRepo = previous?.repository_id === fork.id && previous.owner_id === fork.ownerId;
  let app = sameRepo ? await openApp(key, source, previous) : null;
  let installationId = null;
  if (app) {
    try {
      installationId = await repoInstallation(app, source, fork.ownerId);
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 401) throw error;
      app = null;
    }
  }

  const state = randomToken();
  const browser = randomToken();
  const proof = installationId ? null : b64url(await browserProof(key, browser));
  const result = await env.DB.prepare(`INSERT INTO admin_deployment_github
    (deployment, repository_id, owner_id, state, browser_proof, expires_at, app_enc, installation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(deployment) DO UPDATE SET
      repository_id=excluded.repository_id, owner_id=excluded.owner_id, state=excluded.state,
      browser_proof=excluded.browser_proof, expires_at=excluded.expires_at, app_enc=excluded.app_enc,
      installation_id=excluded.installation_id
    WHERE admin_deployment_github.app_enc IS ? AND admin_deployment_github.installation_id IS ?`)
    .bind(source.deployment, fork.id, fork.ownerId, installationId ? null : state, proof, installationId ? 0 : Date.now() + SETUP_SECONDS * 1000,
      app ? previous?.app_enc ?? null : null, installationId, previous?.app_enc ?? null, previous?.installation_id ?? null).run();
  if (result.meta.changes !== 1) return json({ error: "GitHub connection changed. Try again." }, { status: 409, headers: noStore });
  if (installationId) return json({ connected: true }, { headers: noStore });

  const headers = { ...noStore, "set-cookie": cookie(browser, SETUP_SECONDS) };
  if (app) return json({ url: installUrl(app, state) }, { headers });
  const owner = source.repo.split("/")[0];
  const register = fork.organization ? `/organizations/${owner}/settings/apps/new` : "/settings/apps/new";
  return json({
    url: `https://github.com${register}?state=${state}`,
    manifest: JSON.stringify({
      name: `Aelios Updates ${crypto.randomUUID().slice(0, 13)}`,
      url: `${origin}/admin`,
      description: `Syncs ${source.repo} with upstream Aelios. Install on only this fork.`,
      redirect_url: origin + REGISTERED_PATH,
      setup_url: origin + INSTALLED_PATH,
      setup_on_update: true,
      public: false,
      hook_attributes: { url: origin, active: false },
      default_permissions: permissions
    })
  }, { headers });
}

function backToAdmin(result: "connected" | "error" | "install"): Response {
  const headers = { ...noStore, location: `/admin?update-github=${result}` };
  return new Response(null, { status: 303, headers: result === "connected" ? { ...headers, "set-cookie": cookie("", 0) } : headers });
}

async function callback(request: Request, env: Env, key: string, source: Source): Promise<Response> {
  const url = new URL(request.url);
  const match = request.headers.get("cookie")?.match(/(?:^|;\s*)__Host-aelios-update=([A-Za-z0-9_-]{43})(?:;|$)/);
  if (!match) return backToAdmin("error");
  const row = await connection(env, source);
  if (!row?.browser_proof || !row.state || url.searchParams.get("state") !== row.state || row.expires_at <= Date.now() ||
    !crypto.subtle.timingSafeEqual(fromB64url(row.browser_proof), await browserProof(key, match[1]))) return backToAdmin("error");

  if (url.pathname === REGISTERED_PATH) {
    const code = url.searchParams.get("code");
    if (row.app_enc || !code || !/^[A-Za-z0-9_-]{8,256}$/.test(code)) return backToAdmin("error");
    const claimed = await env.DB.prepare("UPDATE admin_deployment_github SET state=NULL WHERE deployment=? AND state=? AND browser_proof=? AND expires_at>?")
      .bind(source.deployment, row.state, row.browser_proof, Date.now()).run();
    if (claimed.meta.changes !== 1) return backToAdmin("error");

    const data = await githubRequest(`/app-manifests/${code}/conversions`, undefined, {});
    const app = appFrom(data);
    if (!app || !object(data.owner) || data.owner.id !== row.owner_id) return backToAdmin("error");
    const sealed = await sealSecret(key, appContext(source), JSON.stringify(app));
    const installState = randomToken();
    const saved = await env.DB.prepare(`UPDATE admin_deployment_github SET app_enc=?, state=?
      WHERE deployment=? AND browser_proof=? AND expires_at>?`)
      .bind(sealed, installState, source.deployment, row.browser_proof, Date.now()).run();
    if (saved.meta.changes !== 1) return backToAdmin("error");
    return new Response(null, { status: 303, headers: { ...noStore, location: installUrl(app, installState) } });
  }

  // The callback's installation_id is untrusted. Ask GitHub which installation owns this repo.
  const app = await openApp(key, source, row);
  if (!app) return backToAdmin("error");
  const installationId = await repoInstallation(app, source, row.owner_id);
  if (!installationId) return backToAdmin("install");
  const saved = await env.DB.prepare(`UPDATE admin_deployment_github SET installation_id=?, browser_proof=NULL, state=NULL, expires_at=0
    WHERE deployment=? AND state=? AND browser_proof=? AND expires_at>?`)
    .bind(installationId, source.deployment, row.state, row.browser_proof, Date.now()).run();
  return backToAdmin(saved.meta.changes === 1 ? "connected" : "error");
}

export async function handleGitHubConnect(request: Request, env: Env, source: Source | null): Promise<Response> {
  const path = new URL(request.url).pathname;
  const key = env.CHATBOX_API_KEY;
  if (path === GITHUB_CONNECT_PATH) {
    if (request.method !== "POST") return json({ error: "Use POST" }, { status: 405, headers: { ...noStore, allow: "POST" } });
    const auth = await authenticate(request, env);
    if (!key || !auth.ok || auth.keyName !== "CHATBOX_API_KEY") {
      return json({ error: "Main key required" }, { status: 401, headers: noStore });
    }
    if (!source) return json({ error: "Workers Builds deployment required" }, { status: 409, headers: noStore });
    try {
      return await begin(request, env, key, source);
    } catch {
      return json({ error: "Could not connect to GitHub" }, { status: 502, headers: noStore });
    }
  }
  if (![REGISTERED_PATH, INSTALLED_PATH].includes(path)) return new Response(null, { status: 404 });
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...noStore, allow: "GET" } });
  if (!source || !key) return backToAdmin("error");
  try {
    return await callback(request, env, key, source);
  } catch {
    return backToAdmin("error");
  }
}
