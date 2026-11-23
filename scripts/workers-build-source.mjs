export function workersBuildSource(env, remote, workerName) {
  const commit = env.WORKERS_CI_COMMIT_SHA?.trim().toLowerCase() ?? "";
  if (env.WORKERS_CI !== "1" || env.WORKERS_CI_BRANCH !== "main" || !/^[0-9a-f]{40}$/.test(commit)) {
    return { commit: "", repo: "", workerName: "" };
  }
  let path = "";
  try {
    const url = new URL(remote.trim().replace(/^git@github\.com:/, "ssh://git@github.com/"));
    if (url.hostname === "github.com" && ["https:", "ssh:"].includes(url.protocol)) {
      path = url.pathname.slice(1).replace(/\/$/, "").replace(/\.git$/, "");
    }
  } catch {
    // Some build checkouts have no Git remote. The owner can set AELIOS_UPDATE_REPO.
  }
  const repo = /^[a-z\d-]+\/[a-z\d_.-]+$/i.test(path) ? path : "";
  return { commit, repo, workerName };
}
