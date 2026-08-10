#!/usr/bin/env node
// Claude Code calls the statusLine command frequently and shows whatever it
// prints on stdout in its own status bar. We piggyback on that same call to
// also forward usage data to the monitor server, so the dashboard + alert
// thresholds stay in sync without any extra polling.
//
// The server replies with today's budget summary, which we render in the bar:
//   Opus 5 | hari 6/14% | 5j 10% | mgg 11%

const http = require("http");

const PORT = process.env.CCM_PORT || 4756;
const DEADLINE_MS = 1300;

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = input ? JSON.parse(input) : {};
  } catch (e) {
    payload = {};
  }
  forwardUsage(payload).then((summary) => render(payload, summary));
});

// The status bar must never hang a prompt — print what we have and bail.
const deadline = setTimeout(() => render(null, null), DEADLINE_MS);

let rendered = false;
function render(payload, summary) {
  if (rendered) return;
  rendered = true;
  clearTimeout(deadline);

  const rl = (payload && (payload.rate_limits || payload.rateLimits)) || {};
  const fiveHour = rl.five_hour?.used_percentage ?? rl.fiveHour?.used_percentage;
  const sevenDay = rl.seven_day?.used_percentage ?? rl.sevenDay?.used_percentage;

  const parts = [payload?.model?.display_name || payload?.model?.id].filter(Boolean);
  if (summary?.today) {
    const { weekly, budget, ratio } = summary.today;
    const color = ratio >= 100 ? "31" : ratio >= 80 ? "33" : "32";
    parts.push(`\u001b[${color}mhari ${round(weekly)}/${round(budget)}%\u001b[0m`);
  }
  if (typeof fiveHour === "number") parts.push(`5j ${fiveHour}%`);
  if (typeof sevenDay === "number") parts.push(`mgg ${sevenDay}%`);

  process.stdout.write((parts.join(" \u001b[2m|\u001b[0m ") || "Claude Code") + "\n");
  process.exit(0);
}

function round(n) {
  return typeof n === "number" ? (Number.isInteger(n) ? n : n.toFixed(1)) : "?";
}

function forwardUsage(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ eventType: "usage", payload, receivedAt: Date.now() });
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: "/api/event",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 1000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data).daily || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}
