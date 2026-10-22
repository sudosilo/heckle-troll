"use strict";

// HeckleTroll v2 commit heckler. Runs on a schedule in GitHub Actions.
// Finds new commits on every sudosilo repo, sends the diff to the shared server,
// and posts the roast as a comment on the newest commit.

const fs = require("node:fs");

const OWNER = "sudosilo";
const SELF_REPO = "heckle-troll";
const LOG_FILE = "heckle-troll-v2-log.json";
const MARKER = "<!-- heckle-troll -->";
const SKIP_TAG = "[no heckle]";
const KEEP = 40;
const TOKEN = process.env.HECKLE_GH_TOKEN || "";
const SHARED = (process.env.SHARED_SERVER_URL || "").replace(/\/+$/, "");

function say(msg) {
  console.log("[heckle-troll] " + msg);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, msg + "\n\n");
}

async function gh(path, opts) {
  opts = opts || {};
  const r = await fetch("https://api.github.com" + path, {
    method: opts.method || "GET",
    headers: {
      "Authorization": "Bearer " + TOKEN,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "heckle-troll",
      ...(opts.body ? { "Content-Type": "application/json" } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("GitHub " + r.status + " on " + path + ": " + t.slice(0, 160));
  }
  return r.json();
}

async function shared(text) {
  const r = await fetch(SHARED + "/api/shared-server-v1-claude", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: "heckle-troll-push", text })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Shared server said " + r.status + (j.error ? ": " + j.error : ""));
  return String(j.text || "").trim();
}

function clip(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "\n[cut off here]" : s;
}

function loadLog() {
  try {
    const j = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
    return { lastChecked: j.lastChecked || null, lastError: null, heads: j.heads && typeof j.heads === "object" ? j.heads : {}, retry: Array.isArray(j.retry) ? j.retry : [], heckles: Array.isArray(j.heckles) ? j.heckles : [] };
  } catch (e) {
    return { lastChecked: null, lastError: null, heads: {}, retry: [], heckles: [] };
  }
}

function saveLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2) + "\n");
}

async function listRepos() {
  const all = [];
  for (let page = 1; page < 20; page++) {
    const batch = await gh("/users/" + OWNER + "/repos?type=owner&per_page=100&sort=pushed&page=" + page);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all.filter((r) => !r.fork && !r.archived && r.name !== SELF_REPO);
}

async function alreadyHeckled(repo, sha) {
  try {
    const comments = await gh("/repos/" + OWNER + "/" + repo + "/commits/" + sha + "/comments");
    return comments.some((c) => (c.body || "").includes(MARKER));
  } catch (e) {
    return false;
  }
}

async function newCommits(repo, since, lastHead) {
  if (lastHead) {
    try {
      const cmp = await gh("/repos/" + OWNER + "/" + repo.name + "/compare/" + lastHead + "..." + encodeURIComponent(repo.default_branch));
      if (cmp.status === "ahead") return { commits: cmp.commits || [], files: cmp.files || [] };
      if (cmp.status === "identical" || cmp.status === "behind") return { commits: [], files: [] };
    } catch (e) {}
  }
  const from = new Date(new Date(since).getTime() - 60 * 60 * 1000).toISOString();
  const list = await gh("/repos/" + OWNER + "/" + repo.name + "/commits?sha=" + encodeURIComponent(repo.default_branch) + "&since=" + encodeURIComponent(from) + "&per_page=30");
  if (!list.length) return { commits: [], files: [] };
  const commits = list.slice().reverse();
  const oldest = commits[0];
  const newest = commits[commits.length - 1];
  const base = oldest.parents && oldest.parents.length ? oldest.parents[0].sha : null;
  const detail = base
    ? await gh("/repos/" + OWNER + "/" + repo.name + "/compare/" + base + "..." + newest.sha)
    : await gh("/repos/" + OWNER + "/" + repo.name + "/commits/" + newest.sha);
  return { commits, files: detail.files || [] };
}

async function heckleRepo(repo, since, log) {
  const found = await newCommits(repo, since, log.heads[repo.name]);
  const commits = found.commits;
  if (!commits.length) return null;
  const newest = commits[commits.length - 1].sha;

  const counted = commits.filter((c) => !(c.commit.message || "").includes(SKIP_TAG));
  if (!counted.length) { log.heads[repo.name] = newest; return null; }
  const head = counted[counted.length - 1].sha;
  if (await alreadyHeckled(repo.name, head)) { log.heads[repo.name] = newest; return null; }
  const files = found.files;

  let budget = 80000;
  const diffs = [];
  for (const f of files.slice(0, 30)) {
    if (budget <= 0) break;
    const p = clip(f.patch || "(no text diff, binary or too large)", Math.min(budget, 30000));
    budget -= p.length;
    diffs.push("FILE: " + f.filename + " (" + f.status + ", +" + f.additions + " -" + f.deletions + ")\n" + p);
  }
  const messages = counted.map((c) => c.commit.message);
  const prompt = "Heckle this push to " + repo.name + ".\nCommit messages:\n" + messages.join("\n---\n") +
    "\n\nDiff:\n" + (diffs.join("\n\n") || "Empty diff.");
  const text = await shared(prompt);
  if (!text) throw new Error("shared server sent an empty roast");

  const posted = await gh("/repos/" + OWNER + "/" + repo.name + "/commits/" + head + "/comments", {
    method: "POST",
    body: { body: text + "\n\n" + MARKER }
  });
  log.heads[repo.name] = newest;
  return { repo: repo.name, sha: head.slice(0, 7), text, url: posted.html_url || "", at: new Date().toISOString() };
}

async function main() {
  const log = loadLog();
  const startedAt = new Date().toISOString();
  if (!TOKEN) { log.lastError = "HECKLE_GH_TOKEN secret is missing"; saveLog(log); say(log.lastError); return; }
  if (!SHARED) { log.lastError = "SHARED_SERVER_URL variable is missing"; saveLog(log); say(log.lastError); return; }

  if (!log.lastChecked) {
    log.lastChecked = startedAt;
    saveLog(log);
    say("First run. Starting the clock now, the next push gets heckled.");
    return;
  }

  const since = log.lastChecked;
  const retry = new Set(log.retry);
  const repos = (await listRepos()).filter((r) => retry.has(r.name) || (r.pushed_at && r.pushed_at > since));
  const failed = [];
  say(repos.length + " repo(s) pushed since " + since);
  const errors = [];
  for (const repo of repos) {
    try {
      const h = await heckleRepo(repo, since, log);
      if (h) {
        log.heckles.unshift(h);
        say("Heckled " + h.repo + " at " + h.sha + " " + h.url);
      }
    } catch (e) {
      failed.push(repo.name);
      errors.push(repo.name + ": " + String(e.message || e));
      say("Could not heckle " + repo.name + ": " + String(e.message || e));
    }
  }
  if (log.heckles.length > KEEP) log.heckles.length = KEEP;
  log.lastChecked = startedAt;
  log.retry = failed;
  log.lastError = errors.length ? errors.join(" | ").slice(0, 600) : null;
  saveLog(log);
}

main().catch((e) => {
  say("Heckler crashed: " + String(e.message || e));
  process.exitCode = 1;
});
