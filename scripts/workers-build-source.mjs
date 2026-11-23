function githubRepository(remote) {
  try {
    const url = new URL(remote.trim().replace(/^git@github\.com:/, "ssh://git@github.com/"));
    if (url.hostname !== "github.com" || !["https:", "ssh:"].includes(url.protocol)) return "";
    const path = url.pathname.slice(1).replace(/\/$/, "").replace(/\.git$/, "");
    return /^[a-z\d-]+\/[a-z\d_.-]+$/i.test(path) ? path : "";
  } catch {
    return "";
  }
}

function fetchedRepository(fetchHead, commit) {
  const repositories = new Map();
  for (const line of fetchHead.split("\n")) {
    const [revision, , description] = line.split("\t", 3);
    if (revision !== commit || !description) continue;
    // An explicit fetch by commit leaves its source URL in FETCH_HEAD, even without a remote.
    const remote = description.split(" of ").at(-1) ?? "";
    const repo = githubRepository(remote);
    if (repo) repositories.set(repo.toLowerCase(), repo);
  }
  return repositories.size === 1 ? repositories.values().next().value : "";
}

export function workersBuildSource(env, remote, workerName, mainRefs = [], fetchHead = "") {
  const commit = env.WORKERS_CI_COMMIT_SHA?.trim().toLowerCase() ?? "";
  const branch = env.WORKERS_CI_BRANCH?.trim();
  const isMain = branch ? ["main", "refs/heads/main"].includes(branch) : mainRefs.includes(commit);
  if (env.WORKERS_CI !== "1" || !isMain || !/^[0-9a-f]{40}$/.test(commit)) {
    return { commit: "", repo: "", workerName: "" };
  }
  const repo = githubRepository(remote) || fetchedRepository(fetchHead, commit);
  return { commit, repo, workerName };
}
