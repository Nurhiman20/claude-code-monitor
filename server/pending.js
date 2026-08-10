const crypto = require("crypto");

// In-flight approval / question requests.
//
// A Claude Code hook POSTs to /api/ask and the HTTP response is held open until
// someone answers from Telegram or the dashboard — that block is what makes the
// agent wait. Every request here has a hard deadline so a hook can never hang
// the Claude Code session forever.

const MAX_DETAIL = 1200; // Telegram messages stop being readable past this
const MIN_TTL = 10000;
const MAX_TTL = 900000;

const pending = new Map(); // id -> record
const subscribers = new Set();

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emit(kind, record) {
  for (const fn of subscribers) {
    try {
      fn(kind, view(record));
    } catch (e) {
      console.error("[pending subscriber failed]", e.message);
    }
  }
}

// The internal record holds a promise settler and a timer — never send those out.
function view(r) {
  return {
    id: r.id,
    mode: r.mode,
    tool: r.tool,
    project: r.project,
    sessionId: r.sessionId,
    summary: r.summary,
    detail: r.detail,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    resolution: r.resolution || null,
  };
}

function create({ mode, tool, project, sessionId, summary, detail, timeoutMs }) {
  const id = crypto.randomBytes(4).toString("hex"); // short: callback_data is capped at 64 bytes
  const now = Date.now();
  const ttl = Math.min(Math.max(Number(timeoutMs) || 240000, MIN_TTL), MAX_TTL);

  const record = {
    id,
    mode: mode === "question" ? "question" : "permission",
    tool: tool || null,
    project: project || "unknown",
    sessionId: sessionId || null,
    summary: summary || "",
    detail: String(detail || "").slice(0, MAX_DETAIL),
    createdAt: now,
    expiresAt: now + ttl,
  };

  const promise = new Promise((settle) => {
    record.settle = settle;
  });
  record.timer = setTimeout(() => resolve(id, { decision: "timeout" }), ttl);

  pending.set(id, record);
  emit("ask", record);
  return { id, promise, request: view(record) };
}

// decision: allow | deny | answer | timeout | abandoned
function resolve(id, resolution) {
  const record = pending.get(id);
  if (!record) return false;
  clearTimeout(record.timer);
  pending.delete(id);
  record.resolution = resolution;
  record.settle(resolution);
  emit("ask-resolved", record);
  return true;
}

function get(id) {
  const r = pending.get(id);
  return r ? view(r) : null;
}

function list() {
  return Array.from(pending.values()).map(view);
}

// Newest waiting request of a mode. Used when a plain Telegram message arrives:
// a bare text reply answers whatever question is currently on the table.
function latest(mode) {
  let found = null;
  for (const r of pending.values()) {
    if (mode && r.mode !== mode) continue;
    if (!found || r.createdAt > found.createdAt) found = r;
  }
  return found ? view(found) : null;
}

module.exports = { create, resolve, get, list, latest, subscribe };
