#!/usr/bin/env node
// adlc.mjs: keeps a repository in step with the Workbench (ADLC, SDLC and ticket-based development). One file, no dependencies, Node 18 or later.
//
//   node adlc.mjs init --server <https://workbench-api> --token <token>   connect this repository and pull
//   node adlc.mjs pull                                                      bring the repository up to date
//   node adlc.mjs status [--quiet] [--json]                                 is it up to date? (exit 0 yes, 2 behind, 3 cannot tell)
//   node adlc.mjs watch [--interval 300] [--daemon | --stop | --status]      keep it up to date in the background
//   node adlc.mjs tasks                                                     your tasks
//   node adlc.mjs task start <id> | task clear | task current               the task you are working on (this machine only)
//   node adlc.mjs check                                                     are the locked policy files untouched? (works offline)
//   node adlc.mjs telemetry [show|flush|on|off|status]                      what this machine reports back (counts and ids; never code or prompts)
//   node adlc.mjs hooks [install|uninstall|status]                          git hooks that add the task trailers to your commits and report each commit
//   node adlc.mjs evaluate [--base <ref>] [--enforce] [--tests <file>] [--report]   what CI checks a pull request against (and sends the evidence)
//   node adlc.mjs mcp                                                       a tool server for Claude Code: your task, your tasks, the rules (claude mcp add adlc -- node adlc.mjs mcp)
//   node adlc.mjs help | version
//
// What it does: GETs your bundle from the Workbench and writes it into this repository under `.claude/skills/` and `.workbench/` only (it refuses any other path), and merges the Workbench's
// hook entries into `.claude/settings.json` (your own settings are left alone). Your token stays in `.workbench/local.json`, kept out of git.
//
// What it reports back (Step 84), and what it never does. It sends FACTS ABOUT THE WORK: that you pulled and which bundle you hold, the task you started, whether a locked file was edited, that a
// commit was made (its short id, how many files and lines, whether it carries the task trailers) and how Claude Code was used (model, token counts, tool counts, how long), and a short HASH of your git e-mail (never the address) so the Workbench can check that the machine is yours. It NEVER sends source code,
// diffs, prompts, Claude's answers, transcripts, file contents or commit messages. Read the Claude Code transcript, count, discard: the text is never kept or sent. `node adlc.mjs telemetry show` prints
// exactly what is waiting to be sent; `telemetry off` stops reporting on this machine (the Workbench then shows the machine as "no report").
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_VERSION = 2;
const LOCAL = ".workbench/local.json", STATE = ".workbench/state.json", CURRENT = ".workbench/current-task.json", PID = ".workbench/watch.pid", LOG = ".workbench/watch.log", HOOKS = ".workbench/claude-hooks.json";
const QUEUE = ".workbench/queue.jsonl", TELE = ".workbench/telemetry.json", USAGE_STATE = ".workbench/usage-state.json";
const IGNORE = [LOCAL, STATE, CURRENT, PID, LOG, QUEUE, TELE, USAGE_STATE];
const GIT_MARK = "adlc-managed";
const WRITABLE = [".claude/skills/", ".workbench/"];
const MAX_BYTES = 20 * 1024 * 1024;

// ── small helpers ────────────────────────────────────────────────────────────────────────────────────────
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
let MCP = false; // in `mcp` mode stdout carries the protocol and nothing else: anything meant for a person goes to stderr
const out = (s = "") => (MCP ? process.stderr : process.stdout).write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);
const exists = (p) => fs.existsSync(p);
const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const readJson = (p) => { const t = readText(p); if (t === null) return null; try { return JSON.parse(t); } catch { return undefined; } };
function writeText(p, text, mode) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, mode ? { encoding: "utf8", mode } : "utf8"); }
const ago = (iso) => { if (!iso) return "never"; const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)); return s < 90 ? `${s} seconds ago` : s < 5400 ? `${Math.round(s / 60)} minutes ago` : s < 129600 ? `${Math.round(s / 3600)} hours ago` : `${Math.round(s / 86400)} days ago`; };
function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2), eq = k.indexOf("="); if (eq >= 0) flags[k.slice(0, eq)] = k.slice(eq + 1); else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") && ["server", "token", "interval", "dir", "base", "head", "tests", "ci-token", "skip-authors"].includes(k)) flags[k] = argv[++i]; else flags[k] = true; }
    else rest.push(a);
  }
  return { flags, rest };
}
// The control folder used to be called `.adlc` (before Step 91). A repository that still has it is moved to `.workbench` the first time this program runs there: the folder is renamed and the paths
// inside the manifest are rewritten. Nothing is deleted. If both folders exist the old one is left alone and said so. The next `pull` rewrites every file under the new name.
const LEGACY_DIR = ".adlc", CONTROL_DIR = ".workbench";
function migrateLegacy(root) {
  const oldDir = path.join(root, LEGACY_DIR), newDir = path.join(root, CONTROL_DIR);
  if (!exists(oldDir)) return;
  if (exists(newDir)) { err(`Note: this repository has both ${LEGACY_DIR}/ and ${CONTROL_DIR}/. ${CONTROL_DIR}/ is used; ${LEGACY_DIR}/ is left as it is and can be deleted.`); return; }
  try {
    fs.renameSync(oldDir, newDir);
    const man = path.join(newDir, "manifest.json"), text = readText(man);
    if (text !== null) fs.writeFileSync(man, text.split(`${LEGACY_DIR}/`).join(`${CONTROL_DIR}/`), "utf8");
    err(`Moved ${LEGACY_DIR}/ to ${CONTROL_DIR}/. Run \`node adlc.mjs pull\`, then commit the ${CONTROL_DIR} files and replace ${LEGACY_DIR} with ${CONTROL_DIR} in .gitignore and CODEOWNERS.`);
  } catch (e) { err(`Could not move ${LEGACY_DIR}/ to ${CONTROL_DIR}/: ${e.message}. Rename it by hand.`); }
}
/** The repository: where this program is run from, or the folder Claude Code names, or the nearest parent that holds `.workbench/local.json` (or the older `.adlc/local.json`, which is moved). */
function findRoot(flags, forInit) {
  const held = (d) => exists(path.join(d, LOCAL)) || exists(path.join(d, LEGACY_DIR, "local.json"));
  const done = (d) => { migrateLegacy(d); return d; };
  if (typeof flags.dir === "string") return done(path.resolve(flags.dir));
  if (forInit) return done(process.cwd());
  if (process.env.CLAUDE_PROJECT_DIR && held(process.env.CLAUDE_PROJECT_DIR)) return done(process.env.CLAUDE_PROJECT_DIR);
  let d = process.cwd();
  for (;;) { if (held(d)) return done(d); const up = path.dirname(d); if (up === d) break; d = up; }
  return process.cwd();
}
function safePath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 200) return false;
  if (p.includes("\\") || p.includes("\0") || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  if (p.split("/").some((s) => s === "" || s === "." || s === "..")) return false;
  return WRITABLE.some((r) => p.startsWith(r));
}
const abs = (root, rel) => path.join(root, ...rel.split("/"));

// ── connection ───────────────────────────────────────────────────────────────────────────────────────────
function connection(root) {
  const local = readJson(abs(root, LOCAL));
  const server = (process.env.ADLC_SERVER || local?.server || "").replace(/\/+$/, "").replace(/\/api$/, "");
  const token = process.env.ADLC_TOKEN || local?.token || "";
  return { server, token, local: local || null };
}
async function api(conn, pathAndQuery, opt = {}) {
  if (!conn.server || !conn.token) return { ok: false, status: 0, code: "not_connected", message: "This repository is not connected. Run: node adlc.mjs init --server <url> --token <token>" };
  try {
    const headers = { Authorization: `Bearer ${conn.token}`, "X-ADLC-CLI": String(CLI_VERSION), Accept: "application/json", ...(opt.body !== undefined ? { "Content-Type": "application/json" } : {}) };
    const res = await fetch(`${conn.server}/api${pathAndQuery}`, { method: opt.method || "GET", headers, body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined, signal: AbortSignal.timeout(opt.timeoutMs || 30000) });
    const text = await res.text(); let body; try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) return { ok: false, status: res.status, code: body?.error || `http_${res.status}`, message: body?.hint || body?.error || `The Workbench answered ${res.status}.` };
    if (!body) return { ok: false, status: res.status, code: "bad_answer", message: "The Workbench answered with something that is not JSON. Is the server address the API (not the web page)?" };
    return { ok: true, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, code: "unreachable", message: `Could not reach the Workbench at ${conn.server} (${e?.cause?.code || e?.name || "error"}). It may be waking up (a free host sleeps when idle): try again in a minute.` };
  }
}

// ── what this machine reports (Step 84) ──────────────────────────────────────────────────────────────────
const NEVER = ["source code", "diffs", "prompts or Claude's answers", "transcripts", "file contents", "commit messages"];
const QUEUE_MAX = 500;
function teleOn(root) { if (/^(off|0|false|no)$/i.test(process.env.ADLC_TELEMETRY || "")) return false; return readJson(abs(root, TELE))?.enabled !== false; }
const rid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const oneLine = (v, max) => String(v ?? "").replace(/[\r\n\0]+/g, " ").trim().slice(0, max);
/**
 * Step 87: the git e-mail of this repository, reported ONLY as a short hash (never the address) so the Workbench can check it matches the e-mail on the team list.
 * Same recipe as `gitIdentityHash` in the Workbench (a test keeps them equal). null when git has no e-mail set.
 */
let GIT_ID;
function gitIdentity(root) {
  if (GIT_ID !== undefined) return GIT_ID;
  try {
    const e = execFileSync("git", ["config", "--get", "user.email"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim().toLowerCase();
    GIT_ID = e ? sha(`adlc-git-identity:${e}`).slice(0, 16) : null;
  } catch { GIT_ID = null; }
  return GIT_ID;
}
/** Add one fact to the queue. Never throws: reporting must not get in the way of work. */
function queueEvent(root, kind, data = {}, extra = {}) {
  try {
    if (!teleOn(root)) return false;
    if ((kind === "pull" || kind === "heartbeat") && data.gitIdentity === undefined) { const g = gitIdentity(root); if (g) data = { ...data, gitIdentity: g }; }
    const st = readJson(abs(root, STATE)), cur = readJson(abs(root, CURRENT));
    const ev = { id: `${kind}-${rid()}`, kind, at: new Date().toISOString(), data };
    const task = extra.taskId !== undefined ? extra.taskId : cur?.taskId;
    if (task) ev.taskId = task;
    const bh = extra.bundleHash !== undefined ? extra.bundleHash : st?.bundleHash;
    if (bh) ev.bundleHash = bh;
    const q = abs(root, QUEUE);
    fs.mkdirSync(path.dirname(q), { recursive: true });
    fs.appendFileSync(q, `${JSON.stringify(ev)}\n`);
    try { if (fs.statSync(q).size > QUEUE_MAX * 600) { const lines = (readText(q) || "").split("\n").filter(Boolean); fs.writeFileSync(q, `${lines.slice(-QUEUE_MAX).join("\n")}\n`); } } catch { /* fine */ }
    return true;
  } catch { return false; }
}
const queued = (root) => (readText(abs(root, QUEUE)) || "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
/** Send what is queued, up to four reports of 50. Whatever the Workbench accepted or refused is removed (a refusal is permanent); anything else stays for next time. */
async function flush(root, conn, { timeoutMs = 8000 } = {}) {
  const res = { sent: 0, refused: [], left: 0, error: null };
  if (!conn.token || !conn.server) { res.left = queued(root).length; return res; }
  for (let round = 0; round < 4; round++) {
    const all = queued(root);
    if (all.length === 0) break;
    const batch = all.slice(0, 50);
    const r = await api(conn, "/developer/telemetry", { method: "POST", body: { events: batch }, timeoutMs });
    if (!r.ok) { res.error = r.message; break; }
    res.sent += (r.body.accepted || 0) + (r.body.duplicates || 0);
    for (const x of r.body.rejected || []) res.refused.push(x);
    const gone = new Set(batch.map((e) => e.id));
    const keep = queued(root).filter((e) => !gone.has(e.id));
    const q = abs(root, QUEUE), tmp = `${q}.tmp`;
    fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join("\n") + (keep.length ? "\n" : "")); fs.renameSync(tmp, q);
  }
  res.left = queued(root).length;
  return res;
}
async function cmdTelemetry(root, conn, rest) {
  const sub = rest[0] || "status";
  if (sub === "off" || sub === "on") { writeText(abs(root, TELE), `${JSON.stringify({ enabled: sub === "on", changedAt: new Date().toISOString() }, null, 2)}\n`); out(sub === "on" ? "Reporting is on for this machine." : "Reporting is off for this machine. The Workbench will show it as having no report."); return 0; }
  if (sub === "show") {
    const q = queued(root);
    out(`Reporting is ${teleOn(root) ? "on" : "off"}. ${q.length} event${q.length === 1 ? "" : "s"} waiting to be sent:`);
    for (const e of q) out(JSON.stringify(e));
    out(`\nThis program never sends: ${NEVER.join(", ")}. Your git e-mail is sent only as a short hash (gitIdentity), never as the address.`);
    return 0;
  }
  if (sub === "flush") { const r = await flush(root, conn); out(`Sent ${r.sent}, ${r.left} left in the queue.${r.refused.length ? ` The Workbench refused ${r.refused.length}: ${r.refused.map((x) => `${x.id} (${x.reason})`).join("; ")}` : ""}${r.error ? ` Could not finish: ${r.error}` : ""}`); return r.error ? 3 : 0; }
  if (sub === "status") { out(`Reporting is ${teleOn(root) ? "on" : "off"}. ${queued(root).length} event(s) waiting. Server: ${conn.server || "(not connected)"}.\nNever sent: ${NEVER.join(", ")}.\nSee exactly what is waiting: node adlc.mjs telemetry show`); return 0; }
  err("Use: telemetry show | flush | on | off | status"); return 1;
}

// ── Claude Code usage: counts from the transcript, never its text ────────────────────────────────────────
const safeKey = (k) => oneLine(k, 60).replace(/[^A-Za-z0-9_.:\-/ ]/g, "_") || "unknown";
const capMap = (m) => { const e = Object.entries(m).sort((a, b) => b[1] - a[1]); if (e.length <= 40) return Object.fromEntries(e); const top = e.slice(0, 39), rest = e.slice(39).reduce((n, [, v]) => n + v, 0); return { ...Object.fromEntries(top), other: rest }; };
/** Read a Claude Code transcript (one JSON object per line) and COUNT: turns, tokens by kind, models, tools, time. Nothing of any message is kept. */
async function usageFromTranscript(file) {
  const byMsg = new Map(); const tools = new Map(); let first = null, last = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line.length > 20_000_000) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (typeof o?.timestamp === "string") { const t = Date.parse(o.timestamp); if (!Number.isNaN(t)) { if (first === null || t < first) first = t; if (last === null || t > last) last = t; } }
    if (o?.type !== "assistant" || !o.message || typeof o.message !== "object") continue;
    const m = o.message, id = typeof m.id === "string" ? m.id : typeof o.uuid === "string" ? o.uuid : null;
    if (!id) continue;
    const u = m.usage && typeof m.usage === "object" ? m.usage : {};
    const cur = byMsg.get(id) || { model: "", i: 0, o: 0, cr: 0, cc: 0 };
    const n = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    cur.i = Math.max(cur.i, n(u.input_tokens)); cur.o = Math.max(cur.o, n(u.output_tokens)); cur.cr = Math.max(cur.cr, n(u.cache_read_input_tokens)); cur.cc = Math.max(cur.cc, n(u.cache_creation_input_tokens));
    if (typeof m.model === "string" && m.model && m.model !== "<synthetic>") cur.model = m.model;
    byMsg.set(id, cur);
    if (Array.isArray(m.content)) for (const c of m.content) if (c && c.type === "tool_use" && typeof c.id === "string" && typeof c.name === "string") tools.set(c.id, safeKey(c.name));
  }
  const t = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }; const models = {};
  for (const v of byMsg.values()) { if (v.model === "" && v.i + v.o === 0) continue; t.turns++; t.inputTokens += v.i; t.outputTokens += v.o; t.cacheReadTokens += v.cr; t.cacheCreationTokens += v.cc; const k = safeKey(v.model || "unknown"); models[k] = (models[k] || 0) + 1; }
  const toolCount = {}; for (const name of tools.values()) toolCount[name] = (toolCount[name] || 0) + 1;
  const top = Object.entries(models).sort((a, b) => b[1] - a[1])[0];
  return { ...t, toolCalls: tools.size, tools: capMap(toolCount), models: capMap(models), model: top ? top[0] : undefined, ms: first !== null && last !== null ? Math.max(0, last - first) : 0, startedAt: first !== null ? new Date(first).toISOString() : undefined, endedAt: last !== null ? new Date(last).toISOString() : undefined };
}
const sessionHash = (sid) => sha(String(sid)).slice(0, 16);
async function reportUsage(root, input, final, minGapMs) {
  const file = input?.transcript_path;
  if (typeof file !== "string" || !file.endsWith(".jsonl") || !exists(file) || !input.session_id) return false;
  if (fs.statSync(file).size > 512 * 1024 * 1024) return false;
  const sid = sessionHash(input.session_id), usp = abs(root, USAGE_STATE), st = readJson(usp) || {};
  const prev = st[sid];
  if (!final && prev && Date.now() - prev.at < minGapMs) return false;
  const u = await usageFromTranscript(file);
  if (u.turns === 0) return false;
  if (prev && prev.turns === u.turns && !final) return false;
  const data = { sessionId: sid, final, ...u };
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  queueEvent(root, "usage", data);
  st[sid] = { at: Date.now(), turns: u.turns };
  const keys = Object.keys(st); if (keys.length > 50) for (const k of keys.sort((a, b) => st[a].at - st[b].at).slice(0, keys.length - 50)) delete st[k];
  writeText(usp, `${JSON.stringify(st)}\n`);
  return true;
}

// ── the Claude Code settings merge ───────────────────────────────────────────────────────────────────────
/** Add the Workbench's hook entries to .claude/settings.json: entries that run adlc.mjs are replaced, everything else is left alone. Returns a note, or null when nothing changed. */
function mergeHooks(root) {
  const def = readJson(abs(root, HOOKS));
  if (!def || typeof def !== "object" || !def.hooks) return null;
  const p = abs(root, ".claude/settings.json");
  const cur = exists(p) ? readJson(p) : {};
  if (cur === undefined || cur === null || typeof cur !== "object" || Array.isArray(cur)) return ".claude/settings.json is not valid JSON, so the hooks were not added. Fix the file and run pull again.";
  const before = JSON.stringify(cur);
  const hooks = cur.hooks && typeof cur.hooks === "object" && !Array.isArray(cur.hooks) ? cur.hooks : {};
  const ours = (g) => Array.isArray(g?.hooks) && g.hooks.some((h) => typeof h?.command === "string" && h.command.includes("adlc.mjs"));
  for (const [event, groups] of Object.entries(def.hooks)) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((g) => !ours(g));
    hooks[event] = [...kept, ...groups];
  }
  cur.hooks = hooks;
  if (JSON.stringify(cur) === before) return null;
  writeText(p, `${JSON.stringify(cur, null, 2)}\n`);
  return "Claude Code hooks added to .claude/settings.json.";
}
function ensureIgnore(root) {
  const p = path.join(root, ".gitignore");
  const cur = readText(p) ?? "";
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const miss = IGNORE.filter((l) => !have.has(l));
  if (miss.length === 0) return false;
  writeText(p, `${cur}${cur === "" || cur.endsWith("\n") ? "" : "\n"}# adlc.mjs: this machine's connection and state (never commit)\n${miss.join("\n")}\n`);
  return true;
}

// ── pull ─────────────────────────────────────────────────────────────────────────────────────────────────
async function doPull(root, conn, { quiet = false } = {}) {
  const t0 = Date.now();
  const r = await api(conn, "/developer/sync/bundle");
  if (!r.ok) { queueEvent(root, "pull", { result: "failed", reason: oneLine(r.code, 80) }); return { ok: false, ...r }; }
  const b = r.body;
  if (!Array.isArray(b.files) || b.files.some((f) => !safePath(f?.path) || typeof f.content !== "string")) return { ok: false, code: "unsafe_bundle", message: "The bundle holds a path this program will not write. Nothing was changed." };
  if (b.files.reduce((n, f) => n + f.content.length, 0) > MAX_BYTES) return { ok: false, code: "too_big", message: "The bundle is larger than 20 MB. Nothing was changed." };
  const prev = readJson(abs(root, STATE)) || { files: {} };
  const lockedSet = new Set(b.locked || []);
  let written = 0, same = 0, restored = [], removed = 0; const keptEdited = [];
  const nextFiles = {};
  for (const f of b.files) {
    const p = abs(root, f.path), want = sha(f.content), have = exists(p) ? sha(readText(p) ?? "") : null;
    nextFiles[f.path] = want;
    if (have === want) { same++; continue; }
    if (have !== null && lockedSet.has(f.path) && prev.files?.[f.path] !== undefined && have !== prev.files[f.path]) restored.push(f.path); // locked, was pulled before, and differs from what was pulled: edited here
    writeText(p, f.content); written++;
  }
  for (const old of Object.keys(prev.files || {})) {
    if (nextFiles[old] !== undefined || !safePath(old)) continue;
    const p = abs(root, old);
    if (!exists(p)) continue;
    if (sha(readText(p) ?? "") === prev.files[old]) { fs.rmSync(p, { force: true }); removed++; } else keptEdited.push(old);
  }
  const hookNote = mergeHooks(root);
  const ignored = ensureIgnore(root);
  const state = { schema: "adlc.state/1", pulledAt: new Date().toISOString(), cliVersion: CLI_VERSION, projectId: b.projectId, projectName: b.projectName, developer: b.developer, bundleHash: b.bundleHash, contentHash: b.contentHash, parts: b.parts, locked: b.locked || [], tasks: b.tasks || [], files: nextFiles, syncIntervalSeconds: b.syncIntervalSeconds };
  writeText(abs(root, STATE), `${JSON.stringify(state, null, 2)}\n`);
  queueEvent(root, "pull", { result: written === 0 && removed === 0 ? "unchanged" : "ok", bundleHash: b.bundleHash, filesWritten: written, filesRemoved: removed, lockedRestored: restored.length, leftInPlace: keptEdited.length, ms: Date.now() - t0 }, { bundleHash: b.bundleHash });
  return { ok: true, bundle: b, written, same, removed, restored, keptEdited, hookNote, ignored, notices: b.notices || [], state };
}
function printPull(res, root) {
  const b = res.bundle;
  out(`Connected to ${b.projectName} as ${b.developer.name}.`);
  out(`Wrote ${res.written} file${res.written === 1 ? "" : "s"}, ${res.same} already up to date${res.removed ? `, removed ${res.removed} the Workbench no longer sends` : ""}.`);
  if (res.restored.length) { out(`Restored ${res.restored.length} locked policy file${res.restored.length === 1 ? "" : "s"} that had been edited here:`); for (const p of res.restored) out(`  ${p}`); out("Locked files belong to Enterprise Governance; edits to them are not kept."); }
  if (res.keptEdited.length) { out("Left in place (edited here, and no longer sent):"); for (const p of res.keptEdited) out(`  ${p}`); }
  if (res.hookNote) out(res.hookNote);
  if (res.ignored) out("Added this machine's files to .gitignore.");
  for (const n of res.notices) out(`Note: ${n}`);
  { const el = enforcementLine(root); if (el) out(el); }
  out(b.tasks.length ? `Your tasks (${b.tasks.length}): ${b.tasks.map((t) => t.taskId).join(", ")}. Start one with: node adlc.mjs task start <id>` : "No task is assigned to you right now.");
}

// How firmly the pulled rules hold in Claude Code, from the manifest the Workbench wrote (it says the same as the Workbench's "What each tool can do" tab).
function enforcementLine(root) {
  const e = readJson(abs(root, ".workbench/manifest.json"))?.enforcement;
  return e && typeof e.summary === "string" ? `How firmly these rules hold in Claude Code: ${e.summary.replace(/^Strength of this file: /, "")}` : null;
}
// ── status ───────────────────────────────────────────────────────────────────────────────────────────────
function partsBehind(local, remote) { const names = { policy: "policies and guardrails", context: "project context", skills: "agent context and change briefs", tasks: "your tasks" }; return Object.keys(names).filter((k) => local?.parts?.[k] !== remote?.parts?.[k]).map((k) => names[k]); }
function driftOf(root) {
  const st = readJson(abs(root, STATE));
  if (!st || !st.files) return { state: st || null, edited: [], missing: [] };
  const edited = [], missing = [];
  for (const p of st.locked || []) { const f = abs(root, p); if (!exists(f)) missing.push(p); else if (sha(readText(f) ?? "") !== st.files[p]) edited.push(p); }
  return { state: st, edited, missing };
}
async function cmdStatus(root, conn, flags) {
  const d = driftOf(root);
  const r = await api(conn, "/developer/sync/status");
  const res = { connected: !!conn.token, pulledAt: d.state?.pulledAt ?? null, lockedEdited: d.edited, lockedMissing: d.missing, current: null, reachable: r.ok, behind: [], error: null };
  if (!r.ok) res.error = r.message; else {
    res.projectName = r.body.projectName; res.tasks = r.body.tasks; res.notices = r.body.notices;
    res.current = !!d.state && d.state.bundleHash === r.body.bundleHash;
    res.behind = d.state ? partsBehind(d.state, r.body) : ["everything (nothing has been pulled yet)"];
  }
  const cur = readJson(abs(root, CURRENT));
  res.currentTask = cur?.taskId ?? null;
  res.enforcement = readJson(abs(root, ".workbench/manifest.json"))?.enforcement ?? null;
  if (flags.json) { out(JSON.stringify(res, null, 2)); return res.reachable ? (res.current && !d.edited.length && !d.missing.length ? 0 : 2) : 3; }
  const lines = [];
  if (!r.ok) lines.push(`Could not check the Workbench: ${r.message}`, `Last pull: ${ago(d.state?.pulledAt)}.`);
  else if (res.current) lines.push(`Up to date with ${res.projectName} (pulled ${ago(d.state.pulledAt)}).`);
  else lines.push(`Behind the Workbench: ${res.behind.join(", ")} changed. Run: node adlc.mjs pull`);
  if (d.edited.length) lines.push(`Locked policy files edited here: ${d.edited.join(", ")}. A pull restores them.`);
  if (d.missing.length) lines.push(`Locked policy files missing: ${d.missing.join(", ")}. A pull restores them.`);
  for (const n of res.notices || []) lines.push(`Note: ${n}`);
  if (res.currentTask) lines.push(`Current task: ${res.currentTask}.`);
  { const el = enforcementLine(root); if (el) lines.push(el); }
  const clean = r.ok && res.current && !d.edited.length && !d.missing.length;
  if (!flags.quiet || !clean) for (const l of lines) out(l);
  return r.ok ? (clean ? 0 : 2) : 3;
}

// ── tasks ────────────────────────────────────────────────────────────────────────────────────────────────
function cmdTasks(root) {
  const st = readJson(abs(root, STATE));
  if (!st) { err("Nothing has been pulled yet. Run: node adlc.mjs pull"); return 1; }
  const cur = readJson(abs(root, CURRENT));
  if (!st.tasks?.length) { out("No task is assigned to you right now."); return 0; }
  for (const t of st.tasks) out(`${t.taskId === cur?.taskId ? "*" : " "} ${t.taskId.padEnd(22)} ${String(t.mode).padEnd(7)} ${t.title}   (${t.path})`);
  out("\n* = the task you started. Start one with: node adlc.mjs task start <id>");
  return 0;
}
function cmdTask(root, rest) {
  const st = readJson(abs(root, STATE)); const sub = rest[0];
  if (sub === "start") {
    const id = rest[1];
    const t = st?.tasks?.find((x) => x.taskId === id);
    if (!t) { err(`No task "${id ?? ""}" is assigned to you. Run: node adlc.mjs tasks`); return 1; }
    writeText(abs(root, CURRENT), `${JSON.stringify({ taskId: t.taskId, mode: t.mode, startedAt: new Date().toISOString() }, null, 2)}\n`);
    queueEvent(root, "task_started", {}, { taskId: t.taskId });
    out(`Started ${t.taskId}: ${t.title}\nRead ${t.path}; your Claude reads it from .claude/skills/current-task/SKILL.md.`);
    return 0;
  }
  if (sub === "clear") { const had = readJson(abs(root, CURRENT)); fs.rmSync(abs(root, CURRENT), { force: true }); if (had?.taskId) queueEvent(root, "task_cleared", {}, { taskId: had.taskId }); out("No task is marked as started."); return 0; }
  if (sub === "current" || sub === undefined) { const c = readJson(abs(root, CURRENT)); out(c?.taskId ? `Current task: ${c.taskId} (started ${ago(c.startedAt)}).` : "No task is marked as started."); return 0; }
  err("Use: task start <id> | task clear | task current"); return 1;
}

// ── check (offline) ──────────────────────────────────────────────────────────────────────────────────────
function cmdCheck(root) {
  const d = driftOf(root);
  if (!d.state) { err("Nothing has been pulled yet. Run: node adlc.mjs pull"); return 1; }
  queueEvent(root, "check", { editedLocked: d.edited.length, missing: d.missing.length, paths: [...d.edited, ...d.missing].slice(0, 10), bundleHash: d.state.bundleHash });
  if (!d.edited.length && !d.missing.length) { out(`Locked policy files are as pulled ${ago(d.state.pulledAt)} (${(d.state.locked || []).length} files).`); return 0; }
  for (const p of d.edited) out(`EDITED   ${p}`);
  for (const p of d.missing) out(`MISSING  ${p}`);
  out("These are locked. Run: node adlc.mjs pull to restore them.");
  return 2;
}

// ── watch ────────────────────────────────────────────────────────────────────────────────────────────────
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function pidOf(root) { const t = readText(abs(root, PID)); const n = t ? parseInt(t, 10) : NaN; return Number.isInteger(n) ? n : null; }
async function cmdWatch(root, conn, flags) {
  if (flags.stop) { const pid = pidOf(root); if (pid && alive(pid)) { try { process.kill(pid); } catch { /* gone */ } fs.rmSync(abs(root, PID), { force: true }); out(`Stopped the watcher (process ${pid}).`); } else { fs.rmSync(abs(root, PID), { force: true }); out("No watcher is running."); } return 0; }
  if (flags.status) { const pid = pidOf(root); out(pid && alive(pid) ? `The watcher is running (process ${pid}). Log: ${LOG}` : "No watcher is running."); return 0; }
  if (flags.daemon) {
    const pid = pidOf(root);
    if (pid && alive(pid)) { out(`The watcher is already running (process ${pid}).`); return 0; }
    fs.mkdirSync(path.dirname(abs(root, LOG)), { recursive: true });
    const fd = fs.openSync(abs(root, LOG), "a");
    const args = [process.argv[1], "watch", `--dir=${root}`, ...(flags.interval ? [`--interval=${flags.interval}`] : [])];
    const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd], windowsHide: true, cwd: root, env: process.env });
    child.unref(); writeText(abs(root, PID), String(child.pid));
    out(`The watcher is running in the background (process ${child.pid}). Stop it with: node adlc.mjs watch --stop`);
    return 0;
  }
  const floor = Math.max(1, parseInt(process.env.ADLC_MIN_INTERVAL || "", 10) || 30); // 30 seconds; lower only in tests
  let interval = Math.max(floor, parseInt(typeof flags.interval === "string" ? flags.interval : "", 10) || 0);
  let wait = interval || 300, failures = 0, hb = { key: "", at: 0 };
  const stamp = () => new Date().toISOString();
  out(`${stamp()} watching ${conn.server} (every ${wait} s unless the Workbench says otherwise). Ctrl+C stops it.`);
  for (;;) {
    const st = readJson(abs(root, STATE));
    const s = await api(conn, "/developer/sync/status");
    if (s.ok) {
      failures = 0;
      if (!interval && s.body.syncIntervalSeconds) wait = Math.max(floor, s.body.syncIntervalSeconds);
      if (!st || st.bundleHash !== s.body.bundleHash) {
        const p = await doPull(root, conn);
        out(p.ok ? `${stamp()} pulled: ${p.written} written, ${p.restored.length} restored${p.restored.length ? ` (${p.restored.join(", ")})` : ""}.` : `${stamp()} pull failed: ${p.message}`);
      } else {
        const d = driftOf(root);
        if (d.edited.length || d.missing.length) { const p = await doPull(root, conn); out(`${stamp()} restored locked files: ${[...d.edited, ...d.missing].join(", ")}${p.ok ? "" : ` (pull failed: ${p.message})`}`); }
      }
      const now = readJson(abs(root, STATE)), dd = driftOf(root);
      const key = `${now?.bundleHash}|${now?.bundleHash !== s.body.bundleHash}|${dd.edited.length}|${dd.missing.length}`;
      if (key !== hb.key || Date.now() - hb.at > 3_600_000) { queueEvent(root, "heartbeat", { bundleHash: now?.bundleHash, behind: now?.bundleHash !== s.body.bundleHash, editedLocked: dd.edited.length, missing: dd.missing.length, watching: true }); hb = { key, at: Date.now() }; }
      const f = await flush(root, conn);
      if (f.refused.length) out(`${stamp()} the Workbench refused ${f.refused.length} report(s): ${f.refused.map((x) => `${x.id} (${x.reason})`).join("; ")}`);
    } else if (s.status === 401 || s.status === 403) { out(`${stamp()} stopping: ${s.message}`); fs.rmSync(abs(root, PID), { force: true }); return 1; }
    else { failures++; out(`${stamp()} could not reach the Workbench (${s.message})`); }
    const sleep = Math.min(1800, wait * Math.pow(2, Math.min(failures, 4)));
    await new Promise((r) => setTimeout(r, sleep * 1000));
  }
}

// ── hook (called by Claude Code) ─────────────────────────────────────────────────────────────────────────
async function readStdin() {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let t = "", done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(to); process.stdin.destroy(); resolve(t); }; // destroy: an open pipe must not keep the program alive
    const to = setTimeout(finish, 1500);
    process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { t += c; }); process.stdin.on("end", finish); process.stdin.on("error", finish);
  });
}
/** A hook never blocks Claude Code: it always exits 0, and what it prints at session start is added to the session as context. */
async function cmdHook(root, conn, rest) {
  const event = rest[0];
  let input = {}; try { const raw = await readStdin(); if (raw.trim()) input = JSON.parse(raw); } catch { input = {}; }
  const sid = input && typeof input.session_id === "string" ? sessionHash(input.session_id) : null;
  if (event === "stop") { // after each reply: a usage count, at most every five minutes per session
    try { await reportUsage(root, input, false, 5 * 60_000); await flush(root, conn, { timeoutMs: 4000 }); } catch { /* never in the way */ }
    return 0;
  }
  if (event === "session-end") {
    try {
      if (sid) queueEvent(root, "session_end", { sessionId: sid, reason: oneLine(input.reason || "other", 40) });
      await reportUsage(root, input, true, 0);
      await flush(root, conn, { timeoutMs: 4000 });
    } catch { /* never in the way */ }
    return 0;
  }
  if (event !== "session-start") return 0;
  try {
    if (sid) queueEvent(root, "session_start", { sessionId: sid, source: ["startup", "resume", "clear", "compact"].includes(input.source) ? input.source : "other" });
    if (!conn.token) { out("[ADLC] This repository is not connected to the Workbench. Run: node adlc.mjs init --server <url> --token <token>"); return 0; }
    const st = readJson(abs(root, STATE));
    const s = await api(conn, "/developer/sync/status");
    const lines = [];
    if (!s.ok && (s.status === 401 || s.status === 403)) lines.push(`[ADLC] The Workbench refused this machine's token: ${s.message} Working from the last pull (${ago(st?.pulledAt)}); the rules may have moved.`);
    else if (!s.ok) lines.push(`[ADLC] Could not reach the Workbench (${s.message}). Working from the last pull (${ago(st?.pulledAt)}); the rules may have moved.`);
    else {
      let pulled = null;
      if (!st || st.bundleHash !== s.body.bundleHash) { pulled = await doPull(root, conn); if (!pulled.ok) lines.push(`[ADLC] The Workbench has newer rules or tasks but the pull failed: ${pulled.message}`); }
      else { const d = driftOf(root); if (d.edited.length || d.missing.length) pulled = await doPull(root, conn); }
      if (pulled?.ok) {
        lines.push(`[ADLC] Pulled the latest from the Workbench for ${pulled.bundle.projectName}: ${pulled.written} file(s) updated.`);
        if (pulled.restored.length) lines.push(`[ADLC] Locked policy files were edited on this machine and have been restored: ${pulled.restored.join(", ")}. Do not edit them.`);
      } else if (!lines.length) lines.push(`[ADLC] Rules and tasks are up to date with ${s.body.projectName}.`);
      for (const n of s.body.notices || []) lines.push(`[ADLC] ${n}`);
    }
    const cur = readJson(abs(root, CURRENT));
    lines.push(cur?.taskId ? `[ADLC] Current task: ${cur.taskId}. Read .workbench/tasks and .claude/skills/current-task/SKILL.md before you edit anything.` : "[ADLC] No task is marked as started. Ask the developer which task to work on (node adlc.mjs tasks) before you edit anything.");
    for (const l of lines) out(l);
    await flush(root, conn, { timeoutMs: 4000 });
  } catch (e) { out(`[ADLC] The Workbench check did not run (${e?.message || e}).`); }
  return 0;
}

// ── git hooks: the task trailers, and a fact for each commit ─────────────────────────────────────────────
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).replace(/\r?\n$/, "");
const HOOK_NAMES = ["prepare-commit-msg", "post-commit"];
const hookScript = (name) => `#!/bin/sh\n# ${GIT_MARK}: installed by \`node adlc.mjs hooks install\`; remove it with \`node adlc.mjs hooks uninstall\`. It adds the task trailers to your commit message\n# and tells the Workbench a commit was made (its short id and counts; never the message or the code). It never blocks a commit.\nROOT="$(git rev-parse --show-toplevel)"\n[ -f "$ROOT/adlc.mjs" ] && node "$ROOT/adlc.mjs" git-hook ${name} "$@" || true\nexit 0\n`;
function hooksDir(root) { try { return path.resolve(root, git(root, ["rev-parse", "--git-path", "hooks"])); } catch { return null; } }
function cmdHooks(root, rest) {
  const sub = rest[0] || "status", dir = hooksDir(root);
  if (!dir) { err("This folder is not a git repository (or git is not installed)."); return 1; }
  if (sub === "install") {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of HOOK_NAMES) {
      const f = path.join(dir, name), cur = readText(f);
      if (cur !== null && !cur.includes(GIT_MARK)) { out(`Left ${name} alone: you already have one. To use the Workbench's, add this line to it:\n  [ -f "$(git rev-parse --show-toplevel)/adlc.mjs" ] && node "$(git rev-parse --show-toplevel)/adlc.mjs" git-hook ${name} "$@" || true`); continue; }
      fs.writeFileSync(f, hookScript(name), { mode: 0o755 }); try { fs.chmodSync(f, 0o755); } catch { /* windows */ }
      out(`Installed ${name}.`);
    }
    out("Commits made while a task is started (node adlc.mjs task start <id>) now carry ADLC-Task, ADLC-Story, ADLC-Agent and ADLC-Context trailers.");
    return 0;
  }
  if (sub === "uninstall") { for (const name of HOOK_NAMES) { const f = path.join(dir, name), cur = readText(f); if (cur !== null && cur.includes(GIT_MARK)) { fs.rmSync(f, { force: true }); out(`Removed ${name}.`); } } return 0; }
  for (const name of HOOK_NAMES) { const cur = readText(path.join(dir, name)); out(`${name}: ${cur === null ? "not installed" : cur.includes(GIT_MARK) ? "installed" : "someone else's hook (left alone)"}`); }
  return 0;
}
/** Called by git. Adds the trailers for the started task; after the commit, queues a fact about it. Always exits 0. */
async function cmdGitHook(root, conn, rest) {
  const [name, a1, a2] = rest;
  try {
    const cur = readJson(abs(root, CURRENT)), st = readJson(abs(root, STATE));
    if (name === "prepare-commit-msg") {
      if (!cur?.taskId || !a1 || a2 === "merge" || a2 === "squash") return 0;
      const msg = readText(a1); if (msg === null || /^ADLC-Task:/m.test(msg)) return 0;
      const t = (st?.tasks || []).find((x) => x.taskId === cur.taskId);
      const trailers = [`ADLC-Task: ${cur.taskId}`, ...(t?.storyId ? [`ADLC-Story: ${t.storyId}`] : []), ...(t?.agentId ? [`ADLC-Agent: ${t.agentId}`] : []), ...(st?.bundleHash ? [`ADLC-Context: ${st.bundleHash.slice(0, 12)}`] : [])];
      const lines = msg.split("\n"); let last = -1;
      for (let i = 0; i < lines.length; i++) if (lines[i].trim() !== "" && !lines[i].startsWith("#")) last = i;
      if (last < 0) return 0; // an empty message: git will refuse it; leave it alone
      lines.splice(last + 1, 0, "", ...trailers);
      writeText(a1, lines.join("\n"));
      return 0;
    }
    if (name === "post-commit") {
      if (!teleOn(root)) return 0;
      const sha1 = git(root, ["rev-parse", "HEAD"]).slice(0, 12);
      const body = git(root, ["log", "-1", "--format=%B"]); // read here to find the trailer; never sent
      const m = /^ADLC-Task:\s*(\S+)/m.exec(body), tt = m ? m[1] : null;
      let files = 0, added = 0, removed = 0;
      for (const l of git(root, ["diff-tree", "--root", "--no-commit-id", "--numstat", "-r", "HEAD"]).split("\n").filter(Boolean)) { const [a, r] = l.split("\t"); files++; added += /^\d+$/.test(a) ? +a : 0; removed += /^\d+$/.test(r) ? +r : 0; }
      let branch = ""; try { branch = oneLine(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]), 80); } catch { /* none */ }
      const known = tt && (st?.tasks || []).some((x) => x.taskId === tt);
      queueEvent(root, "commit", { sha: sha1, ...(branch ? { branch } : {}), hasTrailers: !!tt, taskMatches: !!(tt && known && (!cur?.taskId || cur.taskId === tt)), files, added, removed, viaHook: true }, { taskId: tt || cur?.taskId || null });
      await flush(root, conn, { timeoutMs: 2500 });
    }
  } catch { /* a git hook never blocks a commit */ }
  return 0;
}

// ── evaluate: what a pull request is checked against (locally or in CI) ────────────────────────────────────
const EVAL_SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?<![A-Za-z0-9])(?:api[_-]?key|password|passwd|secret|token|access[_-]?key|private[_-]?key)\w*\s*[:=]\s*(?:["'`][^"'`\s]{6,}["'`]|(?=[A-Za-z0-9_+/=.-]*\d)[A-Za-z0-9_+/=.-]{16,}(?![\w(]))|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\badlc(?:dev|ci)_[A-Za-z0-9_-]{30,}/i;
const EVAL_SKIP_PATH = /^(?:\.workbench\/|\.claude\/skills\/)|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Cargo\.lock)$/;
const lf = (t) => t.replace(/\r\n/g, "\n");
const policyHashOf = (root, paths) => { // the same hash the Workbench makes of the locked files: sha256 over path, NUL, content, NUL, in path order (line endings made LF first)
  const h = createHash("sha256");
  for (const p of [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) { const t = readText(abs(root, p)); if (t === null) continue; h.update(p, "utf8"); h.update("\0"); h.update(lf(t), "utf8"); h.update("\0"); }
  return h.digest("hex").slice(0, 16);
};
function ciContext() {
  const e = process.env;
  if (e.GITHUB_ACTIONS) { const pr = /^refs\/pull\/(\d+)\//.exec(e.GITHUB_REF || ""); return { provider: "github", branch: e.GITHUB_HEAD_REF || e.GITHUB_REF_NAME || "", prNumber: pr ? Number(pr[1]) : undefined, runId: e.GITHUB_RUN_ID || "", baseRef: e.GITHUB_BASE_REF ? `origin/${e.GITHUB_BASE_REF}` : null }; }
  if (e.TF_BUILD) { const t = e.SYSTEM_PULLREQUEST_TARGETBRANCH; return { provider: "azure", branch: (e.SYSTEM_PULLREQUEST_SOURCEBRANCH || e.BUILD_SOURCEBRANCH || "").replace(/^refs\/heads\//, ""), prNumber: e.SYSTEM_PULLREQUEST_PULLREQUESTID ? Number(e.SYSTEM_PULLREQUEST_PULLREQUESTID) : undefined, runId: e.BUILD_BUILDID || "", baseRef: t ? `origin/${t.replace(/^refs\/heads\//, "")}` : null }; }
  return { provider: "other", branch: "", runId: "", baseRef: null };
}
/** Test totals from a JUnit XML file or a small JSON file {passed, failed, skipped}. Null when the file is not there or not one of those. */
function readTests(file) {
  const t = file ? readText(path.resolve(file)) : null;
  if (t === null) return null;
  try { const j = JSON.parse(t); if (j && typeof j === "object" && ("passed" in j || "failed" in j)) return { passed: Number(j.passed) || 0, failed: Number(j.failed) || 0, skipped: Number(j.skipped) || 0 }; } catch { /* not JSON */ }
  const root = /<testsuites\b([^>]*)>/.exec(t);
  const attrs = (s) => { const o = {}; for (const m of s.matchAll(/\b(tests|failures|errors|skipped|disabled)="(\d+)"/g)) o[m[1]] = Number(m[2]); return o; };
  let a = root ? attrs(root[1]) : null;
  if (!a || a.tests === undefined) { a = { tests: 0, failures: 0, errors: 0, skipped: 0 }; for (const m of t.matchAll(/<testsuite\b([^>]*)>/g)) { const x = attrs(m[1]); a.tests += x.tests || 0; a.failures += x.failures || 0; a.errors += x.errors || 0; a.skipped += (x.skipped || 0) + (x.disabled || 0); } }
  if (!a.tests) return null;
  const failed = (a.failures || 0) + (a.errors || 0), skipped = a.skipped || 0;
  return { passed: Math.max(0, a.tests - failed - skipped), failed, skipped };
}
function gitOut(root, args) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: 120000 }); }
const gitOk = (root, args) => { try { return gitOut(root, args); } catch { return null; } };
/** Added lines that look like a secret, as file:line (never the value). */
function secretsInDiff(diff) {
  const found = []; let file = null, line = 0, skip = false;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) { file = l.startsWith("+++ b/") ? l.slice(6) : null; skip = !file || EVAL_SKIP_PATH.test(file); continue; }
    if (l.startsWith("--- ") || l.startsWith("diff ") || l.startsWith("index ")) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { line = Number(h[1]); continue; }
    if (l.startsWith("+")) { if (!skip && l.length < 4000 && EVAL_SECRET.test(l) && !l.includes("adlc:allow-secret")) found.push(`${file}:${line}`); line++; }
  }
  return found;
}
async function cmdEvaluate(root, flags) {
  const t0 = Date.now(), ci = ciContext();
  const enforce = !!flags.enforce, enforceTrailers = !!flags["enforce-trailers"];
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  // 1. the locked files
  const man = readJson(abs(root, ".workbench/manifest.json"));
  let policyHash = null, lockedEdited = 0, lockedIntact = null;
  if (!man || !Array.isArray(man.locked) || !Array.isArray(man.files)) add("locked_intact", "fail", "There is no .workbench/manifest.json. Run `node adlc.mjs pull` and commit the files it writes.");
  else {
    const want = new Map(man.files.map((f) => [f.path, f.sha256]));
    const bad = [];
    for (const p of man.locked) { const t = readText(abs(root, p)); if (t === null || !want.has(p) || sha(lf(t)).slice(0, 16) !== want.get(p)) bad.push(p); }
    lockedEdited = bad.length; lockedIntact = bad.length === 0; policyHash = policyHashOf(root, man.locked);
    add("locked_intact", bad.length ? "fail" : "pass", bad.length ? `${bad.length} locked file${bad.length === 1 ? "" : "s"} edited or missing: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ", ..." : ""}. Locked files belong to Enterprise Governance.` : `${man.locked.length} locked files are as the Workbench sent them.`);
  }
  // 2. the commits
  const base = typeof flags.base === "string" ? flags.base : process.env.ADLC_BASE || ci.baseRef;
  const head = typeof flags.head === "string" ? flags.head : "HEAD";
  const headSha = (gitOk(root, ["rev-parse", head]) || "").trim();
  let shas = [], rangeNote = "";
  if (base && gitOk(root, ["rev-parse", "--verify", `${base}^{commit}`]) !== null) shas = gitOk(root, ["rev-list", "--no-merges", `${base}..${head}`]).split("\n").filter(Boolean).slice(0, 200);
  else { rangeNote = base ? ` (${base} was not found, so only the last commit was checked)` : " (no base given, so only the last commit was checked)"; if (headSha) shas = [headSha]; }
  const skipRe = new RegExp(typeof flags["skip-authors"] === "string" ? flags["skip-authors"] : "\\[bot\\]|dependabot|renovate", "i");
  let checked = 0, withT = 0; const tasks = new Set(), missing = [];
  for (const c of shas) {
    const who = gitOk(root, ["log", "-1", "--format=%an <%ae>", c]) || "";
    if (skipRe.test(who)) continue;
    checked++;
    const m = /^ADLC-Task:\s*(\S+)/m.exec(gitOk(root, ["log", "-1", "--format=%B", c]) || ""); // read here to find the trailer; never sent
    if (m) { withT++; tasks.add(m[1]); } else missing.push(c.slice(0, 7));
  }
  const tStatus = checked === 0 || missing.length === 0 ? "pass" : enforceTrailers ? "fail" : "warn";
  add("trailers", tStatus, checked === 0 ? "No commits to check." : missing.length === 0 ? `All ${checked} commit${checked === 1 ? "" : "s"} carry ADLC-Task${rangeNote}.` : `${missing.length} of ${checked} commit${checked === 1 ? "" : "s"} have no ADLC-Task trailer (${missing.slice(0, 5).join(", ")}). Use \`node adlc.mjs hooks install\` and \`task start\`.${rangeNote}`);
  // 3. secrets
  let diff = "";
  if (base && gitOk(root, ["rev-parse", "--verify", `${base}^{commit}`]) !== null) diff = gitOk(root, ["diff", "--unified=0", "--no-color", "--no-ext-diff", `${base}...${head}`]) || "";
  else if (headSha) diff = gitOk(root, ["show", "--unified=0", "--no-color", "--no-ext-diff", "--format=", head]) || "";
  const secrets = secretsInDiff(diff);
  add("secrets", secrets.length ? "fail" : "pass", secrets.length ? `${secrets.length} added line${secrets.length === 1 ? "" : "s"} look${secrets.length === 1 ? "s" : ""} like a key or a password: ${secrets.slice(0, 10).join(", ")}${secrets.length > 10 ? ", ..." : ""}. Remove it and rotate it. (A false hit: add "adlc:allow-secret" to the line.)` : "No added line looks like a key or a password.");
  // 4. tests
  const tests = readTests(typeof flags.tests === "string" ? flags.tests : "");
  if (tests) add("tests", tests.failed > 0 ? "fail" : "pass", `${tests.passed} passed, ${tests.failed} failed, ${tests.skipped} skipped.`);
  else if (typeof flags.tests === "string") add("tests", "warn", `No test results could be read from ${flags.tests}.`);
  const failed = checks.filter((c) => c.status === "fail"), warned = checks.filter((c) => c.status === "warn");
  const result = failed.length ? "fail" : warned.length ? "warn" : "pass";
  const report = {
    provider: ci.provider, result, mode: enforce ? "enforce" : "warn", ...(headSha ? { sha: headSha.slice(0, 40) } : {}), ...(ci.branch ? { branch: oneLine(ci.branch, 80) } : {}), ...(ci.prNumber ? { prNumber: ci.prNumber } : {}), ...(ci.runId ? { runId: oneLine(ci.runId, 40) } : {}),
    checksPassed: checks.filter((c) => c.status === "pass").length, checksWarned: warned.length, checksFailed: failed.length, failedChecks: failed.map((c) => c.name), warnedChecks: warned.map((c) => c.name),
    ...(tests ? { testsPassed: tests.passed, testsFailed: tests.failed, testsSkipped: tests.skipped } : {}), commitsChecked: checked, commitsWithTrailers: withT, trailerTasks: [...tasks].slice(0, 10),
    ...(lockedIntact !== null ? { lockedIntact, lockedEdited } : {}), secretsFound: secrets.length, ...(policyHash ? { policyHash } : {}), ms: Date.now() - t0,
  };
  if (flags.json) out(JSON.stringify({ result, mode: report.mode, checks, report }, null, 2));
  else {
    out(`ADLC evaluate (${report.mode} mode)${headSha ? `, ${headSha.slice(0, 12)}` : ""}`);
    for (const c of checks) out(` ${c.status.toUpperCase().padEnd(4)}  ${c.name.padEnd(14)} ${c.detail}`);
    out(`Result: ${result.toUpperCase()}.${result === "fail" ? (enforce ? " The check fails because --enforce is set." : " (Warn mode: this does not fail the build. Add --enforce to make it.)") : result === "warn" && !enforce ? " (Warn mode: this does not fail the build.)" : ""}`);
  }
  // 5. tell the Workbench (with a CI token), without ever failing the build for it
  if (flags.report) {
    const local = readJson(abs(root, LOCAL));
    const conn = { server: (process.env.ADLC_SERVER || (typeof flags.server === "string" ? flags.server : "") || local?.server || "").replace(/\/+$/, "").replace(/\/api$/, ""), token: process.env.ADLC_CI_TOKEN || (typeof flags["ci-token"] === "string" ? flags["ci-token"] : "") };
    if (!conn.server || !conn.token) err("Not reported: set ADLC_SERVER and ADLC_CI_TOKEN (a CI token from the Workbench).");
    else {
      const id = `ci-${ci.provider}-${ci.runId || Date.now().toString(36)}-${(headSha || "nohead").slice(0, 12)}`;
      const r = await api(conn, "/developer/ci/report", { method: "POST", body: { events: [{ id, kind: "ci_run", at: new Date().toISOString(), data: report }] }, timeoutMs: 20000 });
      if (!r.ok) err(`Not reported: ${r.message}`);
      else {
        const ev = (r.body.evaluated || [])[0] || {};
        if (r.body.rejected?.length) err(`The Workbench refused the report: ${r.body.rejected.map((x) => x.reason).join("; ")}`);
        else out(`Reported to the Workbench.${ev.policyCurrent === false ? " The policy files in this repository are OLDER than the ones in force: run `node adlc.mjs pull` and commit." : ev.policyCurrent === true ? " The policy files are the ones in force." : ""}${ev.tasksUnknown ? ` ${ev.tasksUnknown} task id${ev.tasksUnknown === 1 ? "" : "s"} on the commits ${ev.tasksUnknown === 1 ? "is" : "are"} not a task of this project.` : ""}`);
      }
    }
  }
  return enforce && result === "fail" ? 1 : 0;
}

// ── mcp (Step 86) ────────────────────────────────────────────────────────────────────────────────────────
// A small Model Context Protocol server on stdin/stdout (JSON-RPC 2.0, one message per line), no dependencies. Register it with: claude mcp add adlc -- node adlc.mjs mcp
// It gives Claude the developer's task and the rules as TOOLS to call, on top of the skills the pull already wrote. It reads what was pulled; the only things it changes are the ones the
// ordinary commands change (the started task, a pull) and only under .claude/skills/ and .workbench/. It never reads any other file, never sends source code, and it prints nothing but protocol on stdout.
const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_MAX_TEXT = 60000;
const clip = (t, n = MCP_MAX_TEXT) => (t.length > n ? `${t.slice(0, n)}\n\n[cut: ${t.length - n} more characters. Ask for a single file with read_context.]` : t);
const jtext = (v) => JSON.stringify(v, null, 2);
const NOT_PULLED = "Nothing has been pulled into this repository yet. Ask the developer to run: node adlc.mjs pull";
const NO_TASK_WORDS = "No task is assigned to this developer in the Workbench. Do not pick one or start on your own: ask the Tech Lead to assign a story in the Workbench.";
const MCP_TOOLS = [
  { name: "get_current_task", description: "The task this developer is working on: what it is, the agent or ticket it belongs to, and the full task brief. Call this before starting any change.", readOnly: true, props: {} },
  { name: "list_tasks", description: "The tasks the Workbench assigned to this developer (stories, ticket-based changes, agent work). Only these are this developer's work.", readOnly: true, props: {} },
  { name: "start_task", description: "Mark one of the developer's own tasks as the one being worked on, on this machine. The commits then carry its trailers. Only a task from list_tasks is accepted.", readOnly: false, props: { taskId: { type: "string", description: "A task id from list_tasks" } }, required: ["taskId"] },
  { name: "clear_task", description: "Mark no task as started on this machine.", readOnly: false, props: {} },
  { name: "get_policy", description: "The enterprise policies and guardrails in force for this project, in full. They are locked: they take precedence over everything else and must not be edited.", readOnly: true, props: {} },
  { name: "read_context", description: "Read one file the Workbench pulled into this repository (project context, an agent's context, a change brief, a task), by its path from list_context. Other files are refused.", readOnly: true, props: { path: { type: "string", description: "A path from list_context, for example .claude/skills/governance-context/SKILL.md" } }, required: ["path"] },
  { name: "list_context", description: "The files the Workbench pulled into this repository, by path, with a one-line size note. Use read_context to open one.", readOnly: true, props: {} },
  { name: "check_status", description: "Is this repository up to date with the Workbench, and are the locked policy files untouched? Says what changed in the Workbench since the last pull.", readOnly: true, props: {} },
  { name: "pull_updates", description: "Bring the repository up to date with the Workbench now (policies, context, tasks). Writes only under .claude/skills/ and .workbench/; edited locked files are put back.", readOnly: false, props: {} },
  { name: "evaluate_change", description: "Check the change on this branch the way CI will: locked files intact, task trailers on the commits, no secrets added, test results if a file is given. Returns the result and which checks need attention. Reports counts and file names, never code.", readOnly: true, props: { base: { type: "string", description: "The branch or commit the change is measured from (default: main, then master)" } } },
];
const mcpToolList = () => MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", properties: t.props, ...(t.required ? { required: t.required } : {}), additionalProperties: false }, annotations: { readOnlyHint: t.readOnly, openWorldHint: false } }));
const okText = (text) => ({ content: [{ type: "text", text: clip(text) }] });
const badText = (text) => ({ content: [{ type: "text", text }], isError: true });

async function mcpCall(root, conn, name, args) {
  const st = readJson(abs(root, STATE));
  const needPull = () => (!st ? badText(NOT_PULLED) : null);
  switch (name) {
    case "list_tasks": {
      const np = needPull(); if (np) return np;
      if (!st.tasks?.length) return okText(NO_TASK_WORDS);
      const cur = readJson(abs(root, CURRENT));
      return okText(jtext({ project: st.projectName, developer: st.developer?.name ?? null, started: cur?.taskId ?? null, tasks: st.tasks.map((t) => ({ taskId: t.taskId, mode: t.mode, title: t.title, brief: t.path, started: t.taskId === cur?.taskId })) }));
    }
    case "get_current_task": {
      const np = needPull(); if (np) return np;
      if (!st.tasks?.length) return okText(NO_TASK_WORDS);
      const cur = readJson(abs(root, CURRENT));
      const t = cur?.taskId ? st.tasks.find((x) => x.taskId === cur.taskId) : null;
      if (!t) return okText(`No task is started on this machine${cur?.taskId ? ` (${cur.taskId} is no longer assigned to this developer)` : ""}. The developer's tasks:\n${st.tasks.map((x) => `- ${x.taskId} (${x.mode}): ${x.title}`).join("\n")}\nAsk which one to work on, then call start_task.`);
      const brief = readText(abs(root, t.path));
      return okText(`Current task: ${t.taskId} (${t.mode}) started ${ago(cur.startedAt)}.\n\n${brief ?? `The task brief ${t.path} is missing. Call pull_updates.`}`);
    }
    case "start_task": {
      const np = needPull(); if (np) return np;
      const id = typeof args?.taskId === "string" ? args.taskId : "";
      const t = st.tasks?.find((x) => x.taskId === id);
      if (!t) return badText(`No task "${oneLine(id, 60)}" is assigned to this developer. Call list_tasks.`);
      writeText(abs(root, CURRENT), `${JSON.stringify({ taskId: t.taskId, mode: t.mode, startedAt: new Date().toISOString() }, null, 2)}\n`);
      queueEvent(root, "task_started", {}, { taskId: t.taskId });
      await flush(root, conn, { timeoutMs: 3000 });
      return okText(`Started ${t.taskId}: ${t.title}. Call get_current_task for the brief. Commits made here will carry its trailers if the git hooks are installed (node adlc.mjs hooks install).`);
    }
    case "clear_task": {
      const had = readJson(abs(root, CURRENT)); fs.rmSync(abs(root, CURRENT), { force: true });
      if (had?.taskId) { queueEvent(root, "task_cleared", {}, { taskId: had.taskId }); await flush(root, conn, { timeoutMs: 3000 }); }
      return okText("No task is marked as started.");
    }
    case "get_policy": {
      const np = needPull(); if (np) return np;
      const files = (st.locked || []).filter(safePath);
      if (!files.length) return okText("No policy files are locked for this project.");
      return okText(files.map((p) => `===== ${p} =====\n${readText(abs(root, p)) ?? "(missing: call pull_updates)"}`).join("\n\n"));
    }
    case "list_context": {
      const np = needPull(); if (np) return np;
      const lockedSet = new Set(st.locked || []);
      return okText(Object.keys(st.files || {}).filter(safePath).sort().map((p) => `${p}${lockedSet.has(p) ? "  (locked policy)" : ""}`).join("\n") || "Nothing was pulled.");
    }
    case "read_context": {
      const np = needPull(); if (np) return np;
      const p = typeof args?.path === "string" ? args.path : "";
      if (!safePath(p) || st.files?.[p] === undefined) return badText("That is not a file the Workbench pulled into this repository. Call list_context for the paths.");
      const t = readText(abs(root, p));
      return t === null ? badText(`${p} is missing here. Call pull_updates.`) : okText(t);
    }
    case "check_status": {
      const d = driftOf(root);
      if (!d.state) return badText(NOT_PULLED);
      const r = await api(conn, "/developer/sync/status");
      const lines = [];
      if (!r.ok) lines.push(`Could not ask the Workbench: ${r.message}`, `Last pull: ${ago(d.state.pulledAt)}.`);
      else if (d.state.bundleHash === r.body.bundleHash) lines.push(`Up to date with ${r.body.projectName} (pulled ${ago(d.state.pulledAt)}).`);
      else lines.push(`Behind the Workbench: ${partsBehind(d.state, r.body).join(", ")} changed. Call pull_updates.`);
      if (d.edited.length) lines.push(`Locked policy files edited here: ${d.edited.join(", ")}. Do not edit them; pull_updates restores them.`);
      if (d.missing.length) lines.push(`Locked policy files missing: ${d.missing.join(", ")}. pull_updates restores them.`);
      if (r.ok) for (const n of r.body.notices || []) lines.push(`Note: ${n}`);
      { const el = enforcementLine(root); if (el) lines.push(el); }
      return okText(lines.join("\n"));
    }
    case "pull_updates": {
      const p = await doPull(root, conn, { quiet: true });
      if (!p.ok) return badText(`Pull failed: ${p.message}`);
      await flush(root, conn, { timeoutMs: 4000 });
      return okText(`Pulled ${p.bundle.projectName}: wrote ${p.written} file${p.written === 1 ? "" : "s"}, ${p.same} already up to date${p.removed ? `, removed ${p.removed}` : ""}${p.restored.length ? `. Restored ${p.restored.length} locked file${p.restored.length === 1 ? "" : "s"} that had been edited: ${p.restored.join(", ")}` : ""}. Tasks: ${p.bundle.tasks.length ? p.bundle.tasks.map((t) => t.taskId).join(", ") : "none assigned"}.`);
    }
    case "evaluate_change": {
      const base = typeof args?.base === "string" && args.base.trim() ? args.base.trim() : null;
      if (base !== null && !/^[A-Za-z0-9_][A-Za-z0-9_./@^~-]{0,120}$/.test(base)) return badText("The base must be a branch name or a commit.");
      const argv = [fileURLToPath(import.meta.url), "evaluate", "--json", "--dir", root, ...(base ? ["--base", base] : [])];
      try {
        const o = execFileSync(process.execPath, argv, { cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ADLC_TELEMETRY: "off" } });
        const j = JSON.parse(o);
        const attention = (j.checks || []).filter((c) => c.status !== "pass");
        return okText(`Result: ${String(j.result).toUpperCase()}.\n${attention.length ? attention.map((c) => `- ${c.name}: ${c.status}. ${c.detail ?? ""}`).join("\n") : "All checks passed."}\n\n${jtext({ result: j.result, checks: j.checks, report: j.report })}`);
      } catch (e) { return badText(`The check could not run: ${oneLine(String(e?.stderr || e?.message || e), 300)}`); }
    }
    default: return null;
  }
}

async function cmdMcp(flags) {
  MCP = true;
  const root = findRoot(flags, false), conn = connection(root);
  const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const fail = (id, code, message) => send({ id: id ?? null, error: { code, message } });
  let chain = Promise.resolve();
  const handle = async (msg) => {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") { fail(msg?.id, -32600, "Invalid request"); return; }
    const hasId = msg.id !== undefined && msg.id !== null;
    if (!hasId) return; // a notification (initialized, cancelled): nothing to answer
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        send({ id: msg.id, result: { protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "adlc", title: "ADLC Workbench", version: String(CLI_VERSION) }, instructions: "Call get_current_task before changing code. The policies from get_policy are locked and take precedence. Only the tasks from list_tasks are this developer's work: never pick one that is not listed." } });
        return;
      }
      case "ping": send({ id: msg.id, result: {} }); return;
      case "tools/list": send({ id: msg.id, result: { tools: mcpToolList() } }); return;
      case "tools/call": {
        const name = msg.params?.name;
        if (typeof name !== "string" || !MCP_TOOLS.some((t) => t.name === name)) { fail(msg.id, -32602, `Unknown tool: ${oneLine(String(name), 60)}`); return; }
        let result;
        try { result = await mcpCall(root, conn, name, msg.params?.arguments ?? {}); } catch (e) { result = badText(`The tool failed: ${oneLine(String(e?.message || e), 200)}`); }
        send({ id: msg.id, result });
        return;
      }
      default: fail(msg.id, -32601, `Method not found: ${oneLine(msg.method, 60)}`);
    }
  };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const t = line.trim(); if (!t) return;
    let msg; try { msg = JSON.parse(t); } catch { fail(null, -32700, "Parse error"); return; }
    chain = chain.then(() => handle(msg)).catch((e) => err(`adlc mcp: ${e?.message || e}`));
  });
  await new Promise((resolve) => rl.on("close", resolve));
  await chain;
  return 0;
}

// ── init ─────────────────────────────────────────────────────────────────────────────────────────────────
async function cmdInit(root, flags) {
  const server = typeof flags.server === "string" ? flags.server.replace(/\/+$/, "").replace(/\/api$/, "") : "";
  const token = typeof flags.token === "string" ? flags.token : "";
  if (!/^https?:\/\//.test(server)) { err("Give the Workbench API address: --server https://... (the API, not the web page)"); return 1; }
  if (!token.startsWith("adlcdev_")) { err("Give the token the Workbench showed you: --token adlcdev_..."); return 1; }
  if (!exists(path.join(root, ".git"))) err("Note: this folder has no .git. Run this from the root of the repository.");
  const conn = { server, token, local: null };
  const s = await api(conn, "/developer/sync/status");
  if (!s.ok) { err(`Could not connect: ${s.message}`); return 1; }
  writeText(abs(root, LOCAL), `${JSON.stringify({ server, token, projectId: s.body.projectId, developerId: s.body.developer.id, savedAt: new Date().toISOString() }, null, 2)}\n`, 0o600);
  ensureIgnore(root);
  const p = await doPull(root, conn);
  if (!p.ok) { err(`Connected, but the pull failed: ${p.message}`); return 1; }
  printPull(p, root);
  out("\nNext: commit the .claude/skills and .workbench files (not .workbench/local.json), and keep it fresh with: node adlc.mjs watch --daemon");
  out("Optional: node adlc.mjs hooks install   (adds the task trailers to your commits)");
  out(`This machine reports counts and ids back to the Workbench (never ${NEVER.join(", ")}). See what: node adlc.mjs telemetry show. Switch it off: node adlc.mjs telemetry off`);
  await flush(root, conn, { timeoutMs: 5000 });
  return 0;
}

const HELP = `adlc.mjs ${CLI_VERSION}: keeps this repository in step with the Workbench.

  init --server <url> --token <token>   connect this repository and pull
  pull                                  bring the repository up to date
  status [--quiet] [--json]             is it up to date? (exit 0 yes, 2 behind, 3 cannot tell)
  watch [--interval 300]                check every few minutes and pull when something changed
        --daemon | --stop | --status    run it in the background / stop it / say whether it runs
  tasks                                 your tasks
  task start <id> | clear | current     the task you are working on (this machine only)
  check                                 are the locked policy files untouched? (offline)
  telemetry [show|flush|on|off|status]  what this machine reports back: counts and ids, never code or prompts
  hooks [install|uninstall|status]      git hooks: task trailers on your commits, and a fact for each commit
  evaluate [--base <ref>] [--enforce]   what a pull request is checked against: locked files, task trailers, secrets, tests
           [--tests <junit.xml>] [--report] [--json] [--enforce-trailers]   (--report sends it to the Workbench with ADLC_CI_TOKEN)
  mcp                                   a tool server for Claude Code (claude mcp add adlc -- node adlc.mjs mcp)
  version | help`;

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest.shift();
  if (!cmd || cmd === "help" || flags.help) { out(HELP); return 0; }
  if (cmd === "version") { out(`adlc.mjs ${CLI_VERSION}`); return 0; }
  if (Number(process.versions.node.split(".")[0]) < 18) { err("Node 18 or later is needed."); return 1; }
  if (cmd === "init") return cmdInit(findRoot(flags, true), flags);
  if (cmd === "mcp") return cmdMcp(flags);
  if (cmd === "evaluate") return cmdEvaluate(typeof flags.dir === "string" ? path.resolve(flags.dir) : process.cwd(), flags);
  const root = findRoot(flags, false), conn = connection(root);
  switch (cmd) {
    case "pull": { const p = await doPull(root, conn); if (!p.ok) { err(`Pull failed: ${p.message}`); return p.status === 0 ? 3 : 1; } printPull(p, root); await flush(root, conn, { timeoutMs: 4000 }); return 0; }
    case "status": return cmdStatus(root, conn, flags);
    case "watch": return cmdWatch(root, conn, flags);
    case "tasks": return cmdTasks(root);
    case "task": { const code = await cmdTask(root, rest); await flush(root, conn, { timeoutMs: 3000 }); return code; }
    case "check": { const code = cmdCheck(root); await flush(root, conn, { timeoutMs: 3000 }); return code; }
    case "hook": return cmdHook(root, conn, rest);
    case "telemetry": return cmdTelemetry(root, conn, rest);
    case "hooks": return cmdHooks(root, rest);
    case "git-hook": return cmdGitHook(root, conn, rest);
    default: err(`Unknown command "${cmd}".\n\n${HELP}`); return 1;
  }
}
main().then((code) => { process.exitCode = code; }, (e) => { err(`adlc.mjs failed: ${e?.stack || e}`); process.exitCode = 1; });
