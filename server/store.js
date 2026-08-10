const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const LOG_FILE = path.join(DATA_DIR, "events.log");
const MAX_IN_MEMORY = 500;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "");

let events = [];

// Load the tail of the log file on boot so the dashboard isn't empty after a restart.
function loadRecent() {
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
    const tail = lines.slice(-MAX_IN_MEMORY);
    events = tail.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    events = [];
  }
}
loadRecent();

function addEvent(evt) {
  events.push(evt);
  if (events.length > MAX_IN_MEMORY) events.shift();
  fs.appendFile(LOG_FILE, JSON.stringify(evt) + "\n", () => {});
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
