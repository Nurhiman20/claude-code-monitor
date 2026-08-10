require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const store = require("./store");
const daily = require("./daily");
const { notifyBoth, desktopNotify, telegramNotify } = require("./notifiers");
const approvals = require("./approvals");
const bot = require("./bot");

const PORT = process.env.CCM_PORT || 4756;
const THRESHOLDS = [50, 75, 90]; // percent usage checkpoints to alert on

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}

function shortProject(cwd) {
  if (!cwd) return "unknown project";
  // Windows hands us backslash paths, POSIX forward slashes — split on both.
  return cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || cwd;
}

// --- Hook event ingestion -------------------------------------------------
// Body shape sent by hooks/report.js: { eventType, payload, receivedAt }
// `payload` is whatever Claude Code passed the hook on stdin (schema can
// vary a bit between Claude Code versions, so we read defensively).
app.post("/api/event", (req, res) => {
  const { eventType, payload = {}, receivedAt } = req.body || {};
  const sessionId = payload.session_id || payload.sessionId || "unknown-session";
  const project = shortProject(payload.cwd || payload.project_dir);

  const evt = {
    id: `${receivedAt || Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: eventType || "unknown",
    sessionId,
    project,
    time: receivedAt || Date.now(),
    payload,
  };
  // statusLine fires several times per prompt; keeping those in the event log
  // would bloat it fast and they carry nothing the daily tracker doesn't store.
  if (evt.type !== "usage") {
    store.addEvent(evt);
    broadcast({ kind: "event", event: evt });
  }

  switch (evt.type) {
    case "Notification":
      notifyBoth(
        `Claude butuh input — ${project}`,
        payload.message || "Claude Code sedang menunggu kamu."
      );
      break;
    case "Stop":
      notifyBoth(`Task selesai — ${project}`, "Claude Code selesai mengerjakan task ini.");
      break;
    case "SubagentStop":
      notifyBoth(`Subagent selesai — ${project}`, "Salah satu subagent sudah selesai.");
      break;
    case "PreToolUse":
    case "PostToolUse":
      // No notification for every tool call — that would be way too noisy.
      // These only feed the live progress log on the dashboard.
      break;
    case "usage":
      return res.json({ ok: true, daily: handleUsage(sessionId, project, payload) });
    default:
      break;
  }

  res.json({ ok: true });
});

// `rate_limits` entries look like { used_percentage: 11, resets_at: 1786795200 }
// where resets_at is a unix timestamp in *seconds*. Older/newer Claude Code
// versions have shuffled these names around, so read defensively.
function normWindow(w) {
  if (!w || typeof w !== "object") return null;
  const percent = w.used_percentage ?? w.usedPercentage ?? w.percent_used ?? w.percentUsed ?? null;
  if (typeof percent !== "number") return null;
  const reset = w.resets_at ?? w.resetsAt ?? w.reset_at ?? null;
  // Seconds vs milliseconds: anything below ~year 2003 in ms is really seconds.
  const resetsAt = typeof reset === "number" ? (reset < 1e12 ? reset * 1000 : reset) : null;
  return { percent, resetsAt };
}

// Rate limits are account-wide, not per session, so the alert ladders live here
// rather than on the session record.
const windowAlerts = { fiveHour: 0, sevenDay: 0 };

function alertWindow(key, label, win) {
  if (!win) return;
  const crossed = THRESHOLDS.filter((t) => win.percent >= t && t > windowAlerts[key]);
  if (crossed.length) {
    const top = Math.max(...crossed);
    windowAlerts[key] = top;
    notifyBoth(
      `Limit ${label} ${top}%`,
      win.resetsAt
        ? `Sudah pakai ${win.percent}% limit ${label}. Reset ${new Date(win.resetsAt).toLocaleString("id-ID")}.`
        : `Sudah pakai ${win.percent}% limit ${label}.`
    );
  }
  if (win.percent < THRESHOLDS[0]) windowAlerts[key] = 0; // new window, reset ladder
}

function handleUsage(sessionId, project, payload) {
  const rl = payload.rate_limits || payload.rateLimits || {};
  const fiveHour = normWindow(rl.five_hour || rl.fiveHour);
  const sevenDay = normWindow(rl.seven_day || rl.sevenDay);
  const cost = payload.cost?.total_cost_usd;

  const { crossed } = daily.record({ fiveHour, sevenDay, cost, sessionId });
  const summary = daily.summary();

  store.setUsage(sessionId, {
    project,
    fiveHour,
    sevenDay,
    cost: typeof cost === "number" ? cost : null,
    model: payload.model?.display_name || payload.model?.id || null,
    updatedAt: Date.now(),
  });

  if (crossed) notifyDailyBudget(crossed, summary);
  alertWindow("fiveHour", "5 jam", fiveHour);
  alertWindow("sevenDay", "mingguan", sevenDay);

  broadcast({ kind: "usage", sessionId, usage: store.getUsage(sessionId) });
  broadcast({ kind: "daily", daily: summary });
  return summary;
}

function notifyDailyBudget(crossed, summary) {
  const { weekly, budget, remaining } = summary.today;
  const title =
    crossed >= 100 ? `Budget harian habis (${weekly}% / ${budget}%)` : `Budget harian ${crossed}% terpakai`;
  const body =
    crossed >= 100
      ? `Sudah ${weekly}% dari limit mingguan hari ini, lewat budget ${budget}%. Reset ${new Date(summary.today.resetsAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}.`
      : `Terpakai ${weekly}% dari jatah ${budget}% hari ini. Sisa ${remaining}%.`;
  notifyBoth(title, body);
}

// --- Remote approval ------------------------------------------------------
// hooks/ask.js blocks on this response, so the request deliberately stays open
// until someone answers from Telegram or the dashboard (or pending.js times it
// out). A null result means "stay out of the way" — the hook then prints
// nothing and Claude Code falls back to its normal local prompt.
app.post("/api/ask", async (req, res) => {
  req.setTimeout(0);
  res.setTimeout(0);

  const { mode = "permission", payload = {}, timeoutMs } = req.body || {};

  // If Claude Code kills the hook (Ctrl-C, session exit) the socket closes and
  // the request must be retired, otherwise it lingers in Telegram until timeout.
  // Watch the *response*: `req` emits "close" as soon as its body is consumed,
  // which is immediately. `res` closes either because we answered
  // (writableFinished) or because the hook died — only the latter is a give-up.
  let askId = null;
  res.on("close", () => {
    if (askId && !res.writableFinished) approvals.resolve(askId, { decision: "abandoned" });
  });

  let result;
  try {
    result = await approvals.ask({ mode, payload, timeoutMs, onCreated: (id) => (askId = id) });
  } catch (e) {
    console.error("[ask failed]", e.message);
    result = null;
  }
  if (res.writableEnded) return; // hook gave up first
  res.json(result || { decision: "skip" });
});

app.get("/api/ask/pending", (req, res) => res.json(approvals.list()));

app.post("/api/ask/:id/resolve", (req, res) => {
  const { decision, answer } = req.body || {};
  if (!["allow", "deny", "answer", "stop"].includes(decision)) {
    return res.status(400).json({ ok: false, error: "decision harus allow, deny, answer, atau stop" });
  }
  const ok = approvals.resolve(req.params.id, { decision, answer, by: "dashboard" });
  res.status(ok ? 200 : 404).json({ ok });
});

approvals.subscribe((kind, ask) => broadcast({ kind, ask }));

// --- Read endpoints for the dashboard on load ------------------------------
app.get("/api/events", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  res.json(store.getRecent(limit));
});

app.get("/api/usage", (req, res) => {
  res.json(store.allUsage());
});

app.get("/api/daily", (req, res) => {
  res.json(daily.summary());
});

app.put("/api/daily/config", (req, res) => {
  const { budgetPercent, dayStartHour } = req.body || {};
  const config = daily.setConfig({ budgetPercent, dayStartHour });
  const summary = daily.summary();
  broadcast({ kind: "daily", daily: summary });
  res.json({ ok: true, config, daily: summary });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

server.listen(PORT, () => {
  console.log(`Claude Code Monitor listening on http://localhost:${PORT}`);
  bot.start();
});
