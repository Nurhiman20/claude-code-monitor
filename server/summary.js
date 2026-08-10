// Builds the one-glance "task selesai" blurb sent to desktop + Telegram.
//
// No extra model call: Claude's own closing message already says what it did,
// so we strip its Markdown down to a line or two and append the tool trail
// (what was touched since the previous Stop of the same session).

const { lastAssistantText } = require("./transcript");

const MAX_CHARS = parseInt(process.env.CCM_SUMMARY_MAX_CHARS, 10) || 180;
const ENABLED = process.env.CCM_STOP_SUMMARY !== "0";
const FALLBACK = "Claude Code selesai mengerjakan task ini.";

// Where each session's last Stop landed, so the tool trail covers only the turn
// that just finished instead of the whole session.
const marks = new Map(); // `${sessionId}:${kind}` -> timestamp

function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

// Markdown is noise in a notification, and stray `*` `_` `[` would also break
// Telegram's Markdown parser (it rejects the whole message).
function condense(text) {
  if (!text) return "";
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ") // code blocks say nothing in one line
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`>|[\]]/g, "")
    .replace(/[ \t]+/g, " ");

  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";

  // First line is almost always the verdict; pull in one more only if it was terse.
  const picked = [lines[0]];
  if (lines[0].length < 70 && lines[1]) picked.push(lines[1]);
  return truncate(picked.join(" · "), MAX_CHARS);
}

function toolTrail(events, sessionId, since) {
  const files = new Set();
  let calls = 0;
  for (const e of events) {
    if (e.type !== "PostToolUse" || e.sessionId !== sessionId || e.time <= since) continue;
    const p = e.payload || {};
    if (!(p.tool_name || p.toolName)) continue;
    calls++;
    const input = p.tool_input || p.toolInput || {};
    const fp = input.file_path || input.filePath || input.notebook_path;
    if (fp) files.add(String(fp).split(/[\\/]/).filter(Boolean).pop());
  }
  if (!calls) return "";

  const names = Array.from(files);
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` +${names.length - 3}` : "";
  return names.length ? `${calls} tool · ${shown}${more}` : `${calls} tool`;
}

// kind separates a session's own Stop mark from its subagents'.
function forStop(payload = {}, events = [], sessionId = "unknown-session", kind = "Stop") {
  if (!ENABLED) return FALLBACK;

  const key = `${sessionId}:${kind}`;
  const since = marks.get(key) || 0;
  marks.set(key, Date.now());

  const said = condense(lastAssistantText(payload.transcript_path || payload.transcriptPath));
  const trail = toolTrail(events, sessionId, since);

  return [said || FALLBACK, trail].filter(Boolean).join("\n");
}

module.exports = { forStop, condense };
