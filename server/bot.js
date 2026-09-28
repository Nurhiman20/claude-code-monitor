const daily = require("./daily");
const approvals = require("./approvals");

// Long-polls Telegram getUpdates so the bot can answer commands like /limit.
// notifiers.js only pushes outbound alerts — this is the inbound half.

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let offset = 0;

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString("id-ID", { hour: "2-digit", minute: "2-digit" }) : "-";
}

function limitReply() {
  const s = daily.summary();
  const { today, limits, pace, allowance } = s;

  const lines = [`📊 *Limit Claude Code* (${s.date})`, ""];

  if (limits.fiveHour) {
    lines.push(`5 jam: *${limits.fiveHour.percent}%* (reset ${fmtTime(limits.fiveHour.resetsAt)})`);
  }
  if (limits.sevenDay) {
    lines.push(`Mingguan: *${limits.sevenDay.percent}%* (reset ${fmtTime(limits.sevenDay.resetsAt)})`);
  }

  lines.push("");
  lines.push(
    today.calibrating
      ? "Budget harian: mengukur — limit mingguan belum bergerak"
      : `Budget harian: *${today.weekly}%* / ${today.budget}% (${today.ratio}%)`
  );
  lines.push(`Sisa budget hari ini: ${today.remaining}%`);
  if (typeof today.cost === "number") lines.push(`Cost hari ini: $${today.cost.toFixed(2)}`);
  if (allowance) {
    lines.push(`Sisa jatah kumulatif: *${allowance.left}%* (jatah s/d hari ke-${allowance.dayIndex + 1}: ${allowance.total}%)`);
  }
  if (pace) lines.push(`Saran pemakaian/hari: ${pace.recommended}% (${pace.daysLeft} hari lagi)`);

  return lines.join("\n");
}

const HELP = [
  "Perintah:",
  "/limit — cek limit & budget hari ini",
  "/pending — permintaan yang lagi nunggu jawaban",
  "/done — biarkan Claude berhenti (batal jawab pertanyaan)",
  "/help — tampilkan pesan ini",
  "",
  "Kalau Claude nanya, balas aja dengan teks biasa — jawabanmu dikirim balik ke agent-nya.",
].join("\n");

async function reply(text, parseMode = "Markdown") {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}) }),
  });
}

function pendingReply() {
  const list = approvals.list();
  if (!list.length) return "Nggak ada permintaan yang nunggu.";
  return list
    .map((p) => {
      const wait = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
      const head = p.mode === "question" ? `💬 pertanyaan — ${p.project}` : `🔐 ${p.tool} — ${p.project}`;
      return `${head}\n${(p.detail || "").slice(0, 120)}\n(sisa ${wait} detik)`;
    })
    .join("\n\n");
}

async function handleMessage(msg) {
  // Only answer the configured chat — this bot is single-user, not public.
  if (String(msg.chat?.id) !== String(chatId)) return;
  const raw = (msg.text || "").trim();
  const text = raw.toLowerCase();

  if (text.startsWith("/limit") || text.startsWith("/usage") || text.startsWith("/status")) {
    await reply(limitReply());
  } else if (text.startsWith("/pending")) {
    await reply(pendingReply(), null);
  } else if (text.startsWith("/done") || text.startsWith("/stop")) {
    const q = approvals.latest("question");
    if (!q) return reply("Nggak ada pertanyaan yang nunggu.", null);
    approvals.resolve(q.id, { decision: "stop", by: "Telegram" });
    await reply("Oke, Claude dibiarkan berhenti.", null);
  } else if (text.startsWith("/start") || text.startsWith("/help")) {
    await reply(HELP);
  } else if (raw && !raw.startsWith("/")) {
    // A bare message is an answer to whatever question is on the table.
    const q = approvals.latest("question");
    if (q) {
      approvals.resolve(q.id, { decision: "answer", answer: raw, by: "Telegram" });
      await reply("Terkirim ke Claude 👍", null);
    }
  }
}

async function handleCallback(cb) {
  if (String(cb.message?.chat?.id) !== String(chatId)) return;
  const [action, id] = String(cb.data || "").split(":");
  const decision = action === "ok" ? "allow" : action === "no" ? "deny" : null;

  let note = "Permintaan ini sudah kedaluwarsa.";
  if (decision && approvals.resolve(id, { decision, by: "Telegram" })) {
    note = decision === "allow" ? "Diizinkan ✅" : "Ditolak ❌";
  }

  // Answering the callback clears the button's loading spinner in the client.
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cb.id, text: note }),
  });
}

async function poll() {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset}`,
      { signal: AbortSignal.timeout(30000) }
    );
    const data = await res.json();
    for (const update of data.result || []) {
      offset = update.update_id + 1;
      if (update.message) await handleMessage(update.message);
      else if (update.callback_query) await handleCallback(update.callback_query);
    }
  } catch (e) {
    console.error("[telegram poll failed]", e.message);
    setTimeout(poll, 3000); // back off on error instead of hammering the API
    return;
  }
  setImmediate(poll);
}

function start() {
  if (!token || !chatId) return; // Telegram not configured, skip silently.
  poll();
}

module.exports = { start };
