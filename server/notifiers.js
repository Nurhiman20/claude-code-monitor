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

async function telegramNotify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // Telegram not configured, skip silently.

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (e) {
    console.error("[telegram notify failed]", e.message);
  }
}

function notifyBoth(title, message) {
  desktopNotify(title, message);
  telegramNotify(`*${title}*\n${message}`);
}

module.exports = { desktopNotify, telegramNotify, notifyBoth };
