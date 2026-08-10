const pending = require("./pending");
const { telegramSend, telegramEdit, desktopNotify } = require("./notifiers");

// Remote approval: turns a blocking Claude Code hook into a Telegram round trip.
//
//   PreToolUse hook ──► /api/ask ──► Telegram message + inline keyboard
//                                        │
//   hook unblocks ◄── decision ◄─────────┘ (or dashboard, or timeout)
//
// SECURITY: approving here executes tools on this machine, so it is opt-in
// (CCM_REMOTE_APPROVAL=1), restricted to an explicit tool allowlist, and the
// bot only ever talks to TELEGRAM_CHAT_ID. Treat the bot token like an SSH key.

const DEFAULT_TOOLS = "Bash,Write,Edit,MultiEdit,NotebookEdit";

function flag(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v !== "0" && v.toLowerCase() !== "false";
}

function permissionEnabled() {
  return flag("CCM_REMOTE_APPROVAL");
}

function questionsEnabled() {
  // Relaying questions needs the same trust as approving tools: the reply is
  // injected straight back into the agent as if you had typed it.
  return flag("CCM_REMOTE_QUESTIONS", permissionEnabled());
}

function allowedTools() {
  return (process.env.CCM_ASK_TOOLS || DEFAULT_TOOLS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toolAllowed(tool) {
  const list = allowedTools();
  if (list.includes("*")) return true;
  return !!tool && list.includes(tool);
}

const MAX_ROUNDS = parseInt(process.env.CCM_ASK_MAX_ROUNDS, 10) || 20;
const rounds = new Map(); // sessionId -> answered question count, so a Stop loop can't run away

// --- message building ------------------------------------------------------

// One line that says what the tool would actually do. Full input is dumped as
// JSON for anything we don't have a shape for.
function describeTool(tool, input) {
  if (!input || typeof input !== "object") return "";
  switch (tool) {
    case "Bash":
      return input.command || "";
    case "Write":
    case "Read":
      return input.file_path || "";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return input.file_path || "";
    case "WebFetch":
      return input.url || "";
    case "WebSearch":
      return input.query || "";
    case "Agent":
    case "Task":
      return input.description || input.prompt || "";
    default:
      try {
        return JSON.stringify(input);
      } catch {
        return "";
      }
  }
}

function fmtWait(ms) {
  const m = Math.round(ms / 60000);
  return m >= 1 ? `${m} menit` : `${Math.round(ms / 1000)} detik`;
}

function askText(request) {
  const wait = fmtWait(request.expiresAt - request.createdAt);
  if (request.mode === "question") {
    return [
      `💬 Claude nanya — ${request.project}`,
      "",
      request.detail || request.summary || "(pertanyaan tidak terbaca dari transcript)",
      "",
      `Balas pesan ini buat jawab. /done = biarkan Claude berhenti. Nunggu maksimal ${wait}.`,
    ].join("\n");
  }
  return [
    `🔐 Minta izin — ${request.project}`,
    `Tool: ${request.tool || "?"}`,
    "",
    request.detail || "(tanpa detail)",
    "",
    `Pilih tombol di bawah. Kalau didiamkan ${wait}, balik ke prompt izin biasa di terminal.`,
  ].join("\n");
}

const keyboard = (id) => ({
  inline_keyboard: [
    [
      { text: "✅ Izinkan", callback_data: `ok:${id}` },
      { text: "❌ Tolak", callback_data: `no:${id}` },
    ],
  ],
});

const OUTCOME = {
  allow: "✅ Diizinkan",
  deny: "❌ Ditolak",
  answer: "✍️ Dijawab",
  stop: "⏹ Dibiarkan berhenti",
  timeout: "⏳ Timeout — balik ke prompt lokal",
  abandoned: "⚪ Dibatalkan (sesi Claude Code berhenti nunggu)",
};

// --- public API ------------------------------------------------------------

// Returns a decision object for the hook, or null when the hook should stay out
// of the way (feature off, tool not on the allowlist, round cap hit).
async function ask({ mode, payload = {}, timeoutMs, onCreated }) {
  const isQuestion = mode === "question";
  if (isQuestion ? !questionsEnabled() : !permissionEnabled()) return null;

  const tool = payload.tool_name || payload.toolName || null;
  if (!isQuestion && !toolAllowed(tool)) return null;

  const sessionId = payload.session_id || payload.sessionId || null;
  if (isQuestion) {
    const used = rounds.get(sessionId) || 0;
    if (used >= MAX_ROUNDS) {
      rounds.delete(sessionId);
      return null;
    }
  }

  const project = shortProject(payload.cwd || payload.project_dir);
  const detail = isQuestion ? payload.question || "" : describeTool(tool, payload.tool_input || payload.toolInput);

  const { id, promise, request } = pending.create({
    mode,
    tool,
    project,
    sessionId,
    summary: isQuestion ? "Claude menunggu jawaban" : `${tool}`,
    detail,
    timeoutMs,
  });
  if (typeof onCreated === "function") onCreated(id);

  desktopNotify(
    isQuestion ? `Claude nanya — ${project}` : `Minta izin ${tool} — ${project}`,
    "Jawab lewat Telegram atau dashboard."
  );
  // Not awaited here: the answer can land before Telegram even replies with the
  // message id, so keep the promise and resolve it afterwards to edit the message.
  const sent = telegramSend(askText(request), isQuestion ? null : keyboard(id));

  const result = await promise;

  const mid = await sent;
  const tail = result.by ? ` (lewat ${result.by})` : "";
  telegramEdit(mid, `${askText(request)}\n\n— ${OUTCOME[result.decision] || result.decision}${tail}`);

  if (isQuestion) {
    if (result.decision === "answer") rounds.set(sessionId, (rounds.get(sessionId) || 0) + 1);
    else rounds.delete(sessionId); // chain ended — next turn starts counting fresh
  }

  return result;
}

function resolve(id, resolution) {
  return pending.resolve(id, resolution);
}

function shortProject(cwd) {
  if (!cwd) return "unknown project";
  return cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || cwd;
}

module.exports = {
  ask,
  resolve,
  permissionEnabled,
  questionsEnabled,
  allowedTools,
  list: pending.list,
  latest: pending.latest,
  subscribe: pending.subscribe,
};
