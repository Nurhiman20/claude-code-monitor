const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const LOG_FILE = path.join(DATA_DIR, "events.log");
const ARCHIVE_PREFIX = "events.log.";
const MAX_IN_MEMORY = 500;
const TAIL_BYTES = 8 * 1024 * 1024;
const MAX_LOG_BYTES = (Number(process.env.CCM_LOG_MAX_MB) || 50) * 1024 * 1024;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "");

let events = [];
let logBytes = fs.statSync(LOG_FILE).size;

// Reads only the end of the file: this runs before server.listen, so its cost
// is added to every boot, and a whole-file read fails past V8's string limit.
function tailLines(file) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  // Mid-file start lands inside a line (maybe inside a UTF-8 char): drop it.
  const from = start > 0 ? buf.indexOf(10) + 1 : 0;
  if (start > 0 && from === 0) return [];
  return buf.subarray(from).toString("utf8").split("\n").filter(Boolean);
}

function newestArchive() {
  const names = fs.readdirSync(DATA_DIR).filter((n) => n.startsWith(ARCHIVE_PREFIX)).sort();
  return names.length ? path.join(DATA_DIR, names[names.length - 1]) : null;
}

// Load the tail of the log file on boot so the dashboard isn't empty after a restart.
// The newest archive is included so a restart right after rotation keeps its history.
function loadRecent() {
  try {
    const archive = newestArchive();
    const lines = [...(archive ? tailLines(archive) : []), ...tailLines(LOG_FILE)];
    events = lines.slice(-MAX_IN_MEMORY).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    console.error("could not load recent events:", e.message);
    events = [];
  }
}

// Archives get a timestamped name so a rotation never overwrites an older log.
function rotateIfNeeded() {
  if (logBytes < MAX_LOG_BYTES) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    fs.renameSync(LOG_FILE, LOG_FILE + "." + stamp);
    fs.closeSync(fs.openSync(LOG_FILE, "a"));
    logBytes = 0;
  } catch (e) {
    // Windows refuses while an append holds the file; the next event retries.
    console.error("log rotation failed:", e.message);
  }
}

loadRecent();
rotateIfNeeded();

function addEvent(evt) {
  events.push(evt);
  if (events.length > MAX_IN_MEMORY) events.shift();
  const line = JSON.stringify(evt) + "\n";
  logBytes += Buffer.byteLength(line);
  fs.appendFile(LOG_FILE, line, () => {});
  rotateIfNeeded();
  return evt;
}

function getRecent(limit = 200) {
  return events.slice(-limit);
}

// Per-session usage snapshot, kept in memory only (most recent wins).
const usageState = new Map(); // sessionId -> { percent, resetAt, lastAlertedThreshold, raw }

function getUsage(sessionId) {
  return usageState.get(sessionId);
}

function setUsage(sessionId, data) {
  usageState.set(sessionId, data);
}

function allUsage() {
  return Array.from(usageState.entries()).map(([sessionId, v]) => ({ sessionId, ...v }));
}

module.exports = { addEvent, getRecent, getUsage, setUsage, allUsage };
