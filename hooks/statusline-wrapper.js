#!/usr/bin/env node
// Bridges two consumers of the same statusLine invocation: the caveman plugin
// owns what is actually rendered in the status bar, while we quietly forward
// the usage payload to the monitor server. stdin can only be read once, so it
// is buffered here and replayed to the delegate.
//
// The server answers with today's budget summary, which we append to the
// delegate's line so the daily number is visible without opening the dashboard.
// Set CCM_STATUSLINE_SUFFIX=0 to keep the delegate's output untouched.

const http = require("http");
const { spawn } = require("child_process");

const PORT = process.env.CCM_PORT || 4756;
const SHOW_SUFFIX = process.env.CCM_STATUSLINE_SUFFIX !== "0";
const DELEGATE =
  process.env.CCM_STATUSLINE_DELEGATE ||
  "C:\\Users\\angga\\.claude\\plugins\\cache\\caveman\\caveman\\84cc3c14fa1e\\hooks\\caveman-statusline.ps1";
const DEADLINE_MS = 1500;

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const delegate = runDelegate(input);
  const usage = forwardUsage(input);
  Promise.all([delegate, usage]).then(([line, summary]) => render(line, summary));
});

// Hard stop: the status bar must never be the thing that hangs a prompt.
const deadline = setTimeout(() => render(null, null), DEADLINE_MS);

let rendered = false;
function render(line, summary) {
  if (rendered) return;
  rendered = true;
  clearTimeout(deadline);
  const parts = [line && line.trim(), SHOW_SUFFIX ? budgetSuffix(summary) : null].filter(Boolean);
  if (parts.length) process.stdout.write(parts.join(" \u001b[2m|\u001b[0m ") + "\n");
  process.exit(0);
}

function budgetSuffix(summary) {
  if (!summary || !summary.today) return null;
  const { weekly, budget, ratio } = summary.today;
  // green under pace, amber when close, red once the daily budget is gone.
  const color = ratio >= 100 ? "31" : ratio >= 80 ? "33" : "32";
  return `\u001b[${color}mhari ${round(weekly)}/${round(budget)}%\u001b[0m`;
}

function round(n) {
  return typeof n === "number" ? (Number.isInteger(n) ? n : n.toFixed(1)) : "?";
}

function runDelegate(raw) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", DELEGATE],
        { stdio: ["pipe", SHOW_SUFFIX ? "pipe" : "inherit", "ignore"] }
      );
    } catch (e) {
      return resolve(null);
    }
    let out = "";
    if (child.stdout) child.stdout.on("data", (c) => (out += c));
    child.on("error", () => resolve(null));
    // A failed delegate (missing script) makes powershell dump its startup
    // banner on stdout — never let that reach the status bar.
    child.on("close", (code) => resolve(code === 0 ? out || null : null));
    child.stdin.on("error", () => {});
    child.stdin.end(raw);
  });
}

function forwardUsage(raw) {
  return new Promise((resolve) => {
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch (e) {
      payload = {};
    }

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
