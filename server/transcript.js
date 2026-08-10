// Shared transcript reader. Kept dependency-free (fs only) so hooks/ask.js —
// which must stay fast and never crash — can require it directly.

const fs = require("fs");

const TAIL_BYTES = 262144;

// Stop hooks get a `transcript_path` (JSONL) but not the message text itself,
// so pull the last assistant turn out of the tail of the file.
function lastAssistantText(file) {
  if (!file) return "";
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - TAIL_BYTES);
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
    /* unreadable transcript — caller falls back to a generic message */
  }
  return "";
}

module.exports = { lastAssistantText };
