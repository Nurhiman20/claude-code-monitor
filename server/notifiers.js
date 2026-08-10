const notifier = require("node-notifier");

function desktopNotify(title, message) {
  try {
    notifier.notify({
      title,
      message,
      sound: true,
      timeout: 8,
    });
  } catch (e) {
    console.error("[desktop notify failed]", e.message);
  }
}

async function telegramCall(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null; // Telegram not configured, skip silently.

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    const data = await res.json();
    if (!data.ok) console.error(`[telegram ${method} rejected]`, data.description);
    return data.result || null;
  } catch (e) {
    console.error(`[telegram ${method} failed]`, e.message);
    return null;
  }
}

async function telegramNotify(text) {
  await telegramCall("sendMessage", { text, parse_mode: "Markdown" });
}

// Approval prompts carry raw shell commands and file paths, so they are sent as
// plain text — Markdown would mangle (or fail on) unbalanced `_` `*` backticks.
async function telegramSend(text, replyMarkup) {
  const msg = await telegramCall("sendMessage", {
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return msg ? msg.message_id : null;
}

async function telegramEdit(messageId, text) {
  if (!messageId) return;
  await telegramCall("editMessageText", { message_id: messageId, text });
}

function notifyBoth(title, message) {
  desktopNotify(title, message);
  telegramNotify(`*${title}*\n${message}`);
}

module.exports = { desktopNotify, telegramNotify, telegramSend, telegramEdit, notifyBoth };
