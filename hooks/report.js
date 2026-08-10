#!/usr/bin/env node
// Called by Claude Code hooks. Reads the hook's JSON payload from stdin,
// forwards it to the local monitor server, then exits immediately.
// Must never throw or block — a broken hook script would interrupt Claude Code.

const http = require("http");

const PORT = process.env.CCM_PORT || 4756;
const eventType = process.argv[2] || "unknown";

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = input ? JSON.parse(input) : {};
  } catch (e) {
    payload = { raw: input };
  }

  const body = JSON.stringify({ eventType, payload, receivedAt: Date.now() });

  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: PORT,
      path: "/api/event",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 1200,
    },
    (res) => {
      res.resume();
      process.exit(0);
    }
  );

  req.on("timeout", () => req.destroy());
  // If the monitor server isn't running, fail silently — don't break Claude Code.
  req.on("error", () => process.exit(0));
  req.write(body);
  req.end();
});

// Safety net: never hang the hook longer than ~1.5s even if stdin never closes.
setTimeout(() => process.exit(0), 1500);
