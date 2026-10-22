"use strict";

// HeckleTroll v2, part of the Control Troll system.
// No Claude key lives here. Every roast goes through the shared server.

const OWNER = "sudosilo";
const SELF_REPO = "heckle-troll";
const WORKFLOW = "heckle-troll-v2-heckler.yml";
const TOKEN = process.env.HECKLE_GH_TOKEN || "";
const SHARED = (process.env.SHARED_SERVER_URL || "").replace(/\/+$/, "");

async function gh(path, opts) {
  opts = opts || {};
  const headers = {
    "Accept": opts.accept || "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "heckle-troll"
  };
  if (TOKEN) headers.Authorization = "Bearer " + TOKEN;
  if (opts.body) headers["Content-Type"] = "application/json";
  const r = await fetch("https://api.github.com" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("GitHub " + r.status + " on " + path + ": " + t.slice(0, 160));
  }
  if (opts.raw) return r.text();
  if (r.status === 204) return {};
  return r.json();
}

async function rawFile(repo, branch, path) {
  try {
    return await gh("/repos/" + OWNER + "/" + repo + "/contents/" + path.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(branch), { accept: "application/vnd.github.raw+json", raw: true });
  } catch (e) {
    return null;
  }
}

async function shared(app, text) {
  if (!SHARED) throw new Error("SHARED_SERVER_URL is not set on this Vercel project");
  const r = await fetch(SHARED + "/api/shared-server-v1-claude", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app, text })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Shared server said " + r.status + (j.error ? ": " + j.error : ""));
  return String(j.text || "").trim();
}

function clip(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "\n[cut off here, file keeps going]" : s;
}

function versionOf(p) {
  const m = p.match(/-v(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

// Pages first, newest version first, then everything else shortest path first.
function rankFiles(paths) {
  return paths.slice().sort((a, b) => {
    const ah = /\.html?$/i.test(a) ? 0 : 1;
    const bh = /\.html?$/i.test(b) ? 0 : 1;
    if (ah !== bh) return ah - bh;
    const av = versionOf(a), bv = versionOf(b);
    if (av !== bv) return bv - av;
    return a.length - b.length;
  });
}

async function listRepos() {
  const all = [];
  for (let page = 1; page < 20; page++) {
    const batch = await gh("/users/" + OWNER + "/repos?type=owner&per_page=100&sort=pushed&page=" + page);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all
    .filter((r) => !r.fork && !r.archived)
    .map((r) => ({
      name: r.name,
      description: r.description || "",
      homepage: r.homepage || "",
      pushed_at: r.pushed_at,
      language: r.language || "",
      branch: r.default_branch
    }));
}

async function roastRepo(repo) {
  const info = await gh("/repos/" + OWNER + "/" + repo);
  const tree = await gh("/repos/" + OWNER + "/" + repo + "/git/trees/" + info.default_branch + "?recursive=1").catch(() => ({ tree: [] }));
  const paths = (tree.tree || []).filter((t) => t.type === "blob").map((t) => t.path);
  const wanted = rankFiles(paths.filter((p) => /\.(html?|js|mjs|cjs|ts|tsx|jsx|css|json|py)$/i.test(p) && !/node_modules|package-lock|dist\//.test(p)));
  let budget = 120000;
  const parts = [];
  for (const p of wanted.slice(0, 12)) {
    if (budget <= 0) break;
    const t = await rawFile(repo, info.default_branch, p);
    if (t == null) continue;
    const c = clip(t, Math.min(budget, 60000));
    budget -= c.length;
    parts.push("FILE: " + p + "\n" + c);
  }
  const msg = "Roast this whole app.\n\nRepo: " + repo + "\nDescription: " + (info.description || "none") +
    "\nAll files in the repo: " + paths.slice(0, 200).join(", ") +
    "\n\n" + (parts.join("\n\n") || "No readable source files.");
  return { repo, text: await shared("heckle-troll-roast", msg) };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch (e) { out[idx] = ""; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function pageOpening(r) {
  const root = await gh("/repos/" + OWNER + "/" + r.name + "/contents/?ref=" + encodeURIComponent(r.branch));
  const pages = rankFiles((Array.isArray(root) ? root : []).filter((f) => f.type === "file" && /\.html?$/i.test(f.name)).map((f) => f.name));
  if (!pages.length) return "";
  const t = await rawFile(r.name, r.branch, pages[0]);
  if (!t) return "";
  const title = (t.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
  const words = t.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return "title: " + title.trim() + " | opening: " + words.slice(0, 300);
}

async function roastFleet() {
  const repos = await listRepos();
  const openings = await mapLimit(repos, 8, pageOpening);
  const lines = repos.map((r, k) => r.name + " | " + (r.description || "no description") + " | " + (r.language || "") +
    " | last push " + (r.pushed_at || "").slice(0, 10) + (openings[k] ? " | " + openings[k] : ""));
  const text = await shared("heckle-troll-fleet", "Here is the fleet, one repo per line.\n\n" + lines.join("\n"));
  return { text, at: new Date().toISOString(), count: repos.length };
}

async function status() {
  let sharedState = "not set";
  if (SHARED) {
    try {
      const r = await fetch(SHARED + "/api/shared-server-v1-claude");
      const j = await r.json();
      const apps = j.apps || [];
      sharedState = !j.ai ? "online, no AI key" : apps.indexOf("heckle-troll-roast") < 0 ? "online, HeckleTroll not added yet" : "online";
    } catch (e) {
      sharedState = "did not answer";
    }
  }
  return { owner: OWNER, githubToken: !!TOKEN, sharedServer: sharedState };
}

async function checkNow() {
  if (!TOKEN) throw new Error("HECKLE_GH_TOKEN is not set on this Vercel project");
  await gh("/repos/" + OWNER + "/" + SELF_REPO + "/actions/workflows/" + WORKFLOW + "/dispatches", { method: "POST", body: { ref: "main" } });
  return { started: true };
}

async function readBody(req) {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch (e) { body = {}; }
  }
  return body || {};
}

module.exports = async function handler(req, res) {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const what = String((req.query && req.query.do) || "status");
  try {
    if (what === "status") return res.status(200).json(await status());
    if (what === "repos") return res.status(200).json({ repos: await listRepos() });
    if (req.method !== "POST") return res.status(405).json({ error: "use POST for " + what });
    if (what === "roast") {
      const body = await readBody(req);
      const repo = String(body.repo || "").replace(/[^A-Za-z0-9._-]/g, "");
      if (!repo) return res.status(400).json({ error: "repo is required" });
      return res.status(200).json(await roastRepo(repo));
    }
    if (what === "fleet") return res.status(200).json(await roastFleet());
    if (what === "check") return res.status(200).json(await checkNow());
    return res.status(404).json({ error: "not found" });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
