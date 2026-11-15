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

// AskUserQuestion input → [{ question, options: [label], multiSelect }].
function readQuestions(input) {
  const list = Array.isArray(input?.questions) ? input.questions : [];
  return list.map((q) => ({
    question: String(q.question || q.header || ""),
    options: (q.options || []).map((o) => String(o.label || "")),
    multiSelect: !!q.multiSelect,
  }));
}

function choiceLines(request) {
  return (request.questions || []).map((q, qi) => {
    const done = request.answers?.[q.question];
    const head = (request.questions.length > 1 ? `${qi + 1}) ` : "") + q.question;
    const opts = q.options.map((o, oi) => `   ${oi + 1}. ${o}`);
    return [head, ...opts, ...(done ? [`   → ${done}`] : [])].join("\n");
  });
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
  if (request.kind === "choice") {
    return [
      `❓ Claude butuh keputusan — ${request.project}`,
      "",
      choiceLines(request).join("\n\n"),
      "",
      `Pilih tombol, atau balas chat: nomor ("2", pilihan ganda "1,3") atau jawaban sendiri. Kalau didiamkan ${wait}, jawab di terminal.`,
    ].join("\n");
  }
  if (request.kind === "plan") {
    return [
      `📋 Persetujuan plan — ${request.project}`,
      "",
      request.detail || "(plan kosong)",
      "",
      `Setujui atau tolak lewat tombol. Balas chat = tolak sambil kirim masukan ke Claude. Kalau didiamkan ${wait}, jawab di terminal.`,
    ].join("\n");
  }
  return [
    `🔐 Minta izin — ${request.project}`,
    `Tool: ${request.tool || "?"}`,
    "",
    request.detail || "(tanpa detail)",
    "",
    `Pilih tombol. Balas chat = tolak sambil kirim alasan ke Claude. Kalau didiamkan ${wait}, jawab di terminal.`,
  ].join("\n");
}

function keyboard(request) {
  const id = request.id;
  if (request.kind === "choice") {
    // One row per option; callback c:<id>:<question>:<option> stays under 64 bytes.
    const rows = [];
    request.questions.forEach((q, qi) => {
      if (q.multiSelect || request.answers?.[q.question]) return; // multi-select: reply "1,3"
      q.options.forEach((o, oi) => {
        const prefix = request.questions.length > 1 ? `${qi + 1}.${oi + 1} ` : `${oi + 1}. `;
        rows.push([{ text: (prefix + o).slice(0, 60), callback_data: `c:${id}:${qi}:${oi}` }]);
      });
    });
    return { inline_keyboard: rows };
  }
  const yes = request.kind === "plan" ? "✅ Setujui plan" : "✅ Izinkan";
  return {
    inline_keyboard: [
      [
        { text: yes, callback_data: `ok:${id}` },
        { text: "❌ Tolak", callback_data: `no:${id}` },
      ],
    ],
  };
}

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
  // "request" = PermissionRequest hook: fires only when Claude Code is about to
  // prompt, so every tool is relayed (no allowlist), including AskUserQuestion
  // and ExitPlanMode, which need an answer rather than a plain yes.
  const isRequest = mode === "request";
  if (isQuestion ? !questionsEnabled() : !permissionEnabled()) return null;

  const tool = payload.tool_name || payload.toolName || null;
  if (!isQuestion && !isRequest && !toolAllowed(tool)) return null;
  const input = payload.tool_input || payload.toolInput || {};
  const kind = isQuestion
    ? "question"
    : tool === "AskUserQuestion"
      ? "choice"
      : tool === "ExitPlanMode"
        ? "plan"
        : "tool";
  const questions = kind === "choice" ? readQuestions(input) : null;
  if (kind === "choice" && !questions.length) return null;

  const sessionId = payload.session_id || payload.sessionId || null;
  if (isQuestion) {
    const used = rounds.get(sessionId) || 0;
    if (used >= MAX_ROUNDS) {
      rounds.delete(sessionId);
      return null;
    }
  }

  const project = shortProject(payload.cwd || payload.project_dir);
  const detail = isQuestion
    ? payload.question || ""
    : kind === "plan"
      ? String(input.plan || "")
      : kind === "choice"
        ? ""
        : describeTool(tool, input);

  const { id, promise, request } = pending.create({
    mode: isQuestion ? "question" : "permission",
    kind,
    questions,
    tool,
    project,
    sessionId,
    summary: isQuestion ? "Claude menunggu jawaban" : `${tool}`,
    detail,
    timeoutMs,
  });
  if (typeof onCreated === "function") onCreated(id);

  const titles = {
    question: `Claude nanya — ${project}`,
    choice: `Claude butuh keputusan — ${project}`,
    plan: `Persetujuan plan — ${project}`,
    tool: `Minta izin ${tool} — ${project}`,
  };
  desktopNotify(titles[kind], "Jawab lewat Telegram, dashboard, atau terminal.");
  // Not awaited here: the answer can land before Telegram even replies with the
  // message id, so keep the promise and resolve it afterwards to edit the message.
  const sent = telegramSend(askText(request), isQuestion ? null : keyboard(request));
  messages.set(id, sent);

  const result = await promise;
  messages.delete(id);

  const mid = await sent;
  const tail = result.by ? ` (lewat ${result.by})` : "";
  const final = { ...request, answers: result.answers || request.answers };
  telegramEdit(mid, `${askText(final)}\n\n— ${OUTCOME[result.decision] || result.decision}${tail}`);

  if (isQuestion) {
    if (result.decision === "answer") rounds.set(sessionId, (rounds.get(sessionId) || 0) + 1);
    else rounds.delete(sessionId); // chain ended — next turn starts counting fresh
  }

  return result;
}

function resolve(id, resolution) {
  return pending.resolve(id, resolution);
}

const messages = new Map(); // id -> Promise<telegram message id>, for live edits

// One option tapped (or typed) for one question. Resolves the request once
// every question has an answer; until then the message shows progress.
async function choose(id, qi, value) {
  const request = pending.get(id);
  const q = request?.questions?.[qi];
  if (!q || request.answers[q.question]) return null;
  const next = pending.answer(id, q.question, value);
  const done = next.questions.every((x) => next.answers[x.question]);
  if (done) {
    resolve(id, { decision: "answer", answers: next.answers, by: "Telegram" });
  } else {
    const mid = await messages.get(id);
    telegramEdit(mid, askText(next), keyboard(next));
  }
  return { done, label: value };
}

// A typed reply to a choice: numbers pick options ("2", "1,3"), anything else
// is a free-text "Other" answer. Goes to the first unanswered question.
function chooseByText(id, raw) {
  const request = pending.get(id);
  if (!request) return null;
  const qi = request.questions.findIndex((x) => !request.answers[x.question]);
  if (qi < 0) return null;
  const q = request.questions[qi];
  const nums = raw.split(/[,\s]+/).filter(Boolean);
  const picked = nums.every((n) => /^\d+$/.test(n) && +n >= 1 && +n <= q.options.length)
    ? nums.map((n) => q.options[+n - 1])
    : null;
  const value = picked ? (q.multiSelect ? picked.join(", ") : picked[0]) : raw;
  return choose(id, qi, value);
}

// A plain Telegram message answers whatever is newest on the table.
// Resolves to the confirmation to send back, or null when nothing waits.
async function replyText(raw) {
  const p = pending.latest();
  if (!p) return null;
  if (p.mode === "question") {
    resolve(p.id, { decision: "answer", answer: raw, by: "Telegram" });
    return "Terkirim ke Claude 👍";
  }
  if (p.kind === "choice") {
    const r = await chooseByText(p.id, raw);
    if (!r) return null;
    return r.done ? "Jawaban terkirim ke Claude 👍" : `Dicatat: ${r.label}. Lanjut pertanyaan berikutnya.`;
  }
  resolve(p.id, { decision: "deny", message: raw, by: "Telegram" });
  return p.kind === "plan" ? "Plan ditolak, masukanmu dikirim ke Claude." : "Ditolak, alasanmu dikirim ke Claude.";
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
  describeTool,
  choose,
  replyText,
  get: pending.get,
  list: pending.list,
  latest: pending.latest,
  subscribe: pending.subscribe,
};
