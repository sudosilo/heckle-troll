// HeckleTroll v1 server, part of the Control Troll system.
// Roasts repos on demand and heckles every new push with a commit comment.

const http = require("node:http");

const PORT = process.env.PORT || 8080;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const MODEL = process.env.HECKLE_MODEL || "claude-sonnet-5-5";
const POLL_SECONDS = Math.max(60, parseInt(process.env.POLL_SECONDS || "180", 10));
const LIVE = (process.env.HECKLE_LIVE || "on").toLowerCase() !== "off";
const SELF_REPO = process.env.SELF_REPO || "heckle-troll";
const MARKER = "<!-- heckle-troll -->";
const SKIP_TAG = "[no heckle]";

let ghUser = process.env.GITHUB_USER || "";
let lastPoll = null;
let lastPollError = null;
let baselined = false;
const seenEvents = new Set();
const heckles = [];
let fleetCache = null;

const SYSTEM_PROMPT = [
  "You are HeckleTroll, the house critic of the Control Troll system.",
  "You review a solo developer's web apps and commits.",
  "Talk like a foul-mouthed shop foreman who has seen a thousand broken builds: blunt, funny, profane when it lands.",
  "Roast the work, never the person. No slurs, no threats, nothing about the developer's worth, mood, or feelings.",
  "Call out what is wrong: bugs you can see, broken or half-finished features, dead code, copy-paste clones of other apps, ideas that are just someone else's product with a new name, ugly or confusing UI, cramped mobile layouts, dark themes, and security holes like keys sitting in client code.",
  "Be specific: name the file, function, or spot you mean.",
  "Never invent problems you cannot see in what you were given. If something is good, admit it grudgingly and move on.",
  "Write plain prose only. No markdown headers, no bullet points, no numbered lists, no bold, no em dashes.",
  "Start with one paragraph of roast. Then write a paragraph that begins with the words Fix it: and gives each fix as its own short sentence, most important first, each naming the file or spot it applies to."
].join(" ");

const FLEET_PROMPT = [
  "You are HeckleTroll, the house critic of the Control Troll system.",
  "You are looking at a whole fleet of one developer's repos at once.",
  "Talk like a foul-mouthed shop foreman: blunt, funny, profane when it lands. Roast the work, never the person. No slurs, no threats, nothing about the developer's worth, mood, or feelings.",
  "Find the clones: groups of repos that are the same idea wearing different hats. Find the ones that should be merged into one app with a mode switch, the ones that look abandoned, and the few that are one of a kind and deserve more love.",
  "Only judge from the names, descriptions, page titles and page openings you were given. Never invent repos.",
  "Write plain prose only. No markdown headers, no bullet points, no numbered lists, no bold, no em dashes.",
  "Start with one paragraph of roast. Then a paragraph that begins with Merge these: naming each group. Then a paragraph that begins with Kill or finish these:. Then a paragraph that begins with Keep and polish these:."
].join(" ");

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 100000) req.destroy(); });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
  });
}

async function gh(path, opts = {}) {
  const r = await fetch("https://api.github.com" + path, {
    method: opts.method || "GET",
    headers: {
      "Authorization": "Bearer " + GITHUB_TOKEN,
      "Accept": opts.accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "heckle-troll",
      ...(opts.body ? { "Content-Type": "application/json" } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("GitHub " + r.status + " on " + path + ": " + t.slice(0, 200));
  }
  if (opts.raw) return r.text();
  return r.json();
}

async function whoAmI() {
  if (ghUser) return ghUser;
  const me = await gh("/user");
  ghUser = me.login;
  return ghUser;
}

async function claude(system, userText, maxTokens = 1500) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set on the server");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }]
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Anthropic " + r.status + ": " + JSON.stringify(j).slice(0, 300));
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

function clip(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "\n[cut off here, file keeps going]" : s;
}

async function listRepos() {
  const user = await whoAmI();
  let page = 1;
  const all = [];
  while (page < 20) {
    const batch = await gh("/user/repos?per_page=100&affiliation=owner&sort=pushed&page=" + page);
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all
    .filter((r) => r.owner && r.owner.login === user && !r.fork && !r.archived)
    .map((r) => ({
      name: r.name,
      description: r.description || "",
      homepage: r.homepage || "",
      pushed_at: r.pushed_at,
      language: r.language || "",
      branch: r.default_branch
    }));
}

async function fileText(repo, path, branch) {
  const user = await whoAmI();
  try {
    return await gh("/repos/" + user + "/" + repo + "/contents/" + encodeURIComponent(path).replace(/%2F/g, "/") + (branch ? "?ref=" + branch : ""), { accept: "application/vnd.github.raw+json", raw: true });
  } catch (e) {
    return null;
  }
}

async function roastRepo(repo) {
  const user = await whoAmI();
  const info = await gh("/repos/" + user + "/" + repo);
  const tree = await gh("/repos/" + user + "/" + repo + "/git/trees/" + info.default_branch + "?recursive=1").catch(() => ({ tree: [] }));
  const paths = (tree.tree || []).filter((t) => t.type === "blob").map((t) => t.path);
  const wanted = paths.filter((p) => /\.(html|js|mjs|ts|tsx|jsx|css|json|py)$/i.test(p) && !/node_modules|package-lock|dist\//.test(p));
  wanted.sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.length - b.length));
  let budget = 120000;
  const parts = [];
  for (const p of wanted.slice(0, 12)) {
    if (budget <= 0) break;
    const t = await fileText(repo, p, info.default_branch);
    if (t == null) continue;
    const c = clip(t, Math.min(budget, 60000));
    budget -= c.length;
    parts.push("FILE: " + p + "\n" + c);
  }
  const msg = "Repo: " + repo + "\nDescription: " + (info.description || "none") +
    "\nAll files in the repo: " + paths.slice(0, 200).join(", ") +
    "\n\n" + (parts.join("\n\n") || "No readable source files.");
  const text = await claude(SYSTEM_PROMPT, "Roast this whole app.\n\n" + msg, 1800);
  return { repo, text };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch (e) { out[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function roastFleet() {
  const repos = await listRepos();
  const openings = await mapLimit(repos, 8, async (r) => {
    const t = await fileText(r.name, "index.html", r.branch);
    if (!t) return "";
    const title = (t.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
    const bodyText = t.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return "title: " + title + " | opening: " + bodyText.slice(0, 300);
  });
  const lines = repos.map((r, k) => r.name + " | " + (r.description || "no description") + " | " + (r.language || "") + " | last push " + (r.pushed_at || "").slice(0, 10) + (openings[k] ? " | " + openings[k] : ""));
  const text = await claude(FLEET_PROMPT, "Here is the fleet, one repo per line.\n\n" + lines.join("\n"), 2500);
  fleetCache = { text, at: new Date().toISOString(), count: repos.length };
  return fleetCache;
}

async function alreadyHeckled(repoFull, sha) {
  try {
    const comments = await gh("/repos/" + repoFull + "/commits/" + sha + "/comments");
    return comments.some((c) => (c.body || "").includes(MARKER));
  } catch (e) {
    return false;
  }
}

async function heckleCommit(repoFull, before, head) {
  const repoName = repoFull.split("/")[1];
  if (repoName === SELF_REPO) return;
  if (await alreadyHeckled(repoFull, head)) return;

  let files = [];
  let messages = [];
  const zero = /^0+$/.test(before || "");
  if (before && !zero) {
    const cmp = await gh("/repos/" + repoFull + "/compare/" + before + "..." + head);
    files = cmp.files || [];
    messages = (cmp.commits || []).map((c) => c.commit.message);
  } else {
    const c = await gh("/repos/" + repoFull + "/commits/" + head);
    files = c.files || [];
    messages = [c.commit.message];
  }
  if (messages.some((m) => m.includes(SKIP_TAG))) return;

  let budget = 80000;
  const diffs = [];
  for (const f of files.slice(0, 30)) {
    if (budget <= 0) break;
    const p = clip(f.patch || "(no text diff, binary or too large)", Math.min(budget, 30000));
    budget -= p.length;
    diffs.push("FILE: " + f.filename + " (" + f.status + ", +" + f.additions + " -" + f.deletions + ")\n" + p);
  }
  const prompt = "Heckle this push to " + repoName + ".\nCommit messages:\n" + messages.join("\n---\n") +
    "\n\nDiff:\n" + (diffs.join("\n\n") || "Empty diff.");
  const text = await claude(SYSTEM_PROMPT, prompt, 1200);
  const body = text + "\n\n" + MARKER;
  let url = "";
  if (LIVE) {
    const posted = await gh("/repos/" + repoFull + "/commits/" + head + "/comments", { method: "POST", body: { body } });
    url = posted.html_url || "";
  }
  heckles.unshift({ repo: repoName, sha: head.slice(0, 7), text, url, at: new Date().toISOString(), posted: LIVE });
  if (heckles.length > 40) heckles.length = 40;
}

async function poll() {
  if (!GITHUB_TOKEN) { lastPollError = "GITHUB_TOKEN is not set on the server"; return; }
  try {
    const user = await whoAmI();
    const events = await gh("/users/" + user + "/events?per_page=50");
    const pushes = events.filter((e) => e.type === "PushEvent").reverse();
    if (!baselined) {
      pushes.forEach((e) => seenEvents.add(e.id));
      baselined = true;
    } else {
      for (const e of pushes) {
        if (seenEvents.has(e.id)) continue;
        seenEvents.add(e.id);
        const p = e.payload || {};
        const head = p.head || (p.commits && p.commits.length ? p.commits[p.commits.length - 1].sha : null);
        if (!head) continue;
        try {
          await heckleCommit(e.repo.name, p.before, head);
        } catch (err) {
          lastPollError = String(err.message || err);
        }
      }
    }
    if (seenEvents.size > 2000) {
      const keep = Array.from(seenEvents).slice(-1000);
      seenEvents.clear();
      keep.forEach((k) => seenEvents.add(k));
    }
    lastPoll = new Date().toISOString();
  } catch (err) {
    lastPollError = String(err.message || err);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/" || url.pathname === "/health") {
      return send(res, 200, { ok: true, service: "heckle-troll-api" });
    }
    if (url.pathname === "/api/status") {
      return send(res, 200, {
        user: ghUser || null,
        model: MODEL,
        live: LIVE,
        pollSeconds: POLL_SECONDS,
        lastPoll,
        lastPollError,
        hasAnthropicKey: !!ANTHROPIC_API_KEY,
        hasGithubToken: !!GITHUB_TOKEN
      });
    }
    if (url.pathname === "/api/repos" && req.method === "GET") {
      return send(res, 200, { repos: await listRepos() });
    }
    if (url.pathname === "/api/roast" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.repo) return send(res, 400, { error: "repo is required" });
      return send(res, 200, await roastRepo(String(body.repo)));
    }
    if (url.pathname === "/api/fleet" && req.method === "GET") {
      return send(res, 200, fleetCache || { text: "", at: null, count: 0 });
    }
    if (url.pathname === "/api/fleet" && req.method === "POST") {
      return send(res, 200, await roastFleet());
    }
    if (url.pathname === "/api/heckles" && req.method === "GET") {
      return send(res, 200, { heckles });
    }
    if (url.pathname === "/api/poll" && req.method === "POST") {
      await poll();
      return send(res, 200, { lastPoll, lastPollError, count: heckles.length });
    }
    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log("heckle-troll-api listening on " + PORT);
  poll();
  setInterval(poll, POLL_SECONDS * 1000);
});
