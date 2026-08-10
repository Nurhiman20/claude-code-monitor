#!/usr/bin/env node
// Blocking hook: asks *you* (via Telegram / the dashboard) instead of the terminal.
//
//   node ask.js permission   → PreToolUse: allow or deny a tool call
//   node ask.js question     → Stop: relay Claude's question and feed back your reply
//
// The POST to /api/ask deliberately hangs until someone answers, so give the
// hook a generous `timeout` in settings.json. Anything unexpected (server down,
// bad JSON, feature disabled) exits 0 with no output — Claude Code then falls
// back to its normal local prompt. Failing open is the whole safety story here.

const fs = require("fs");
const http = require("http");

const PORT = process.env.CCM_PORT || 4756;
const mode = process.argv[2] === "question" ? "question" : "permission";
const TIMEOUT_MS =
  parseInt(process.env.CCM_ASK_TIMEOUT_MS, 10) || (mode === "question" ? 540000 : 240000);
// Only relay a Stop when Claude actually asked something, unless told otherwise.
const STOP_MODE = (process.env.CCM_ASK_ON_STOP || "question").toLowerCase();

function bail() {
  process.exit(0); // no stdout = no opinion = normal Claude Code behaviour
}

// Never let the hook outlive the server's own deadline by much.
const guard = setTimeout(bail, TIMEOUT_MS + 15000);
guard.unref?.();

// --- transcript ------------------------------------------------------------
// Stop hooks get a `transcript_path` (JSONL) but not the message text itself,
// so pull the last assistant turn out of the tail of the file.
function lastAssistantText(file) {
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - 262144);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue; // first line is usually a partial record — skip it
      }
      const msg = entry.message || entry;
      if (entry.type !== "assistant" && msg.role !== "assistant") continue;
      const content = msg.content;
      const text = Array.isArray(content)
        ? content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n").trim()
        : typeof content === "string"
          ? content.trim()
          : "";
      if (text) return text;
    }
  } catch {
    /* unreadable transcript — caller falls back to a generic prompt */
  }
  return "";
}

function looksLikeQuestion(text) {
  const tail = text.split("\n").filter(Boolean).slice(-3).join(" ");
  return /[?？]\s*$/.test(tail.trim()) || /[?？]/.test(tail);
}

// --- decision output -------------------------------------------------------
function emitPermission(result) {
  if (!result || (result.decision !== "allow" && result.decision !== "deny")) bail();
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: result.decision,
        permissionDecisionReason:
          result.decision === "allow"
            ? `Disetujui lewat ${result.by || "remote approval"}.`
            : `Ditolak lewat ${result.by || "remote approval"}. Jangan jalankan tool ini; tanya dulu kalau perlu.`,
      },
    })
  );
  process.exit(0);
}

function emitAnswer(result) {
  if (!result || result.decision !== "answer" || !result.answer) bail();
  // `block` on Stop hands `reason` back to Claude as the next user turn.
  process.stdout.write(JSON.stringify({ decision: "block", reason: result.answer }));
  process.exit(0);
}

// --- main ------------------------------------------------------------------
function send(payload, onResult) {
  const body = JSON.stringify({ mode, payload, timeoutMs: TIMEOUT_MS });
  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: PORT,
      path: "/api/ask",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    },
    (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => {
        try {
          onResult(JSON.parse(out));
        } catch {
          bail();
        }
      });
    }
  );
  req.setTimeout(0); // the whole point is to wait
  req.on("error", bail); // monitor server not running — stay out of the way
  req.write(body);
  req.end();
}

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = input ? JSON.parse(input) : {};
  } catch {
    bail();
  }

  if (mode === "question") {
    const text = lastAssistantText(payload.transcript_path || payload.transcriptPath || "");
    if (!text) bail();
    if (STOP_MODE !== "always" && !looksLikeQuestion(text)) bail();
    send({ ...payload, question: text }, emitAnswer);
  } else {
    send(payload, emitPermission);
  }
});
