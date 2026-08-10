const fs = require("fs");
const path = require("path");

// Daily budget tracker.
//
// Claude Code only reports rolling window totals (`five_hour`, `seven_day`),
// never "how much did I burn today". So we sample those totals every time the
// statusLine hook fires and accumulate the *increments* into per-day buckets.
// Today's weekly-limit consumption is the sum of increments since the day
// boundary, which is exactly the number to compare against a daily budget.

const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "daily-usage.json");
const KEEP_DAYS = 60;
const HISTORY_DAYS = 14;
const DAY_MS = 86400000;

// Alerts fire at these fractions of the daily budget (100 = budget used up).
const BUDGET_THRESHOLDS = [50, 80, 100, 120];

const DEFAULT_CONFIG = {
  budgetPercent: 14, // share of the weekly limit allowed per day
  dayStartHour: 0, // local hour a new "day" starts at
};

const EMPTY_DAY = { weekly: 0, fiveHour: 0, cost: 0, firstAt: null, lastAt: null, alerted: 0 };

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = {
  config: { ...DEFAULT_CONFIG },
  // Last sample of each account-wide window, used to compute increments.
  state: { fiveHour: null, sevenDay: null, costBySession: {} },
  days: {}, // "YYYY-MM-DD" -> { weekly, fiveHour, cost, firstAt, lastAt, alerted }
};

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    db = {
      config: { ...DEFAULT_CONFIG, ...(parsed.config || {}) },
      state: { fiveHour: null, sevenDay: null, costBySession: {}, ...(parsed.state || {}) },
      days: parsed.days || {},
    };
  } catch {
    // No file yet (or it got corrupted) — start from a clean slate.
  }
}
load();

let saveTimer = null;
function save() {
  // The statusLine hook fires many times per prompt; don't hit the disk on each.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(FILE, JSON.stringify(db, null, 2), () => {});
  }, 1500);
  if (saveTimer.unref) saveTimer.unref();
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// Local calendar day, shifted so a day can start at e.g. 04:00 instead of midnight.
function dayKey(ts, startHour = db.config.dayStartHour) {
  const d = new Date(ts - startHour * 3600000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayBounds(ts, startHour = db.config.dayStartHour) {
  const shifted = new Date(ts - startHour * 3600000);
  const start = new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate()).getTime()
    + startHour * 3600000;
  return { start, end: start + DAY_MS };
}

function getDay(key, at) {
  let day = db.days[key];
  if (!day) {
    day = { ...EMPTY_DAY, firstAt: at, lastAt: at };
    db.days[key] = day;
  }
  return day;
}

function prune() {
  const keys = Object.keys(db.days).sort();
  if (keys.length <= KEEP_DAYS) return;
  for (const key of keys.slice(0, keys.length - KEEP_DAYS)) delete db.days[key];
}

// How much of `next` was consumed since the previous sample of the same window.
function windowDelta(name, next) {
  if (!next || typeof next.percent !== "number") return 0;
  const prev = db.state[name];
  db.state[name] = { percent: next.percent, resetsAt: next.resetsAt ?? null, at: Date.now() };

  // First sample ever: only establish a baseline. Attributing the whole running
  // total to today would wildly overstate the first day of tracking.
  if (!prev) return 0;
  // Window rolled over — everything on the clock was burned inside the new window.
  if (next.resetsAt && prev.resetsAt && next.resetsAt !== prev.resetsAt) return next.percent;
  return Math.max(0, next.percent - prev.percent);
}

function costDelta(sessionId, total) {
  if (!sessionId || typeof total !== "number") return 0;
  const prev = db.state.costBySession[sessionId];
  db.state.costBySession[sessionId] = total;
  if (typeof prev !== "number") return total;
  return Math.max(0, total - prev);
}

/**
 * Fold one usage sample into today's bucket.
 * @returns {{ key: string, day: object, crossed: number|null }} crossed = budget
 *   threshold (in % of budget) newly passed by this sample, if any.
 */
function record({ fiveHour, sevenDay, cost, sessionId, at = Date.now() }) {
  const key = dayKey(at);
  const day = getDay(key, at);

  day.weekly = +(day.weekly + windowDelta("sevenDay", sevenDay)).toFixed(2);
  day.fiveHour = +(day.fiveHour + windowDelta("fiveHour", fiveHour)).toFixed(2);
  day.cost = +(day.cost + costDelta(sessionId, cost)).toFixed(4);
  day.lastAt = at;

  const budget = db.config.budgetPercent;
  let crossed = null;
  if (budget > 0) {
    const ratio = (day.weekly / budget) * 100;
    const passed = BUDGET_THRESHOLDS.filter((t) => ratio >= t && t > (day.alerted || 0));
    if (passed.length) {
      crossed = Math.max(...passed);
      day.alerted = crossed;
    }
  }

  prune();
  save();
  return { key, day, crossed };
}

function historyFrom(now) {
  const out = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const key = dayKey(now - i * DAY_MS);
    const day = db.days[key] || EMPTY_DAY;
    out.push({ date: key, weekly: day.weekly, fiveHour: day.fiveHour, cost: day.cost });
  }
  return out;
}

function summary(now = Date.now()) {
  const key = dayKey(now);
  const day = db.days[key] || EMPTY_DAY;
  const budget = db.config.budgetPercent;
  const { end } = dayBounds(now);
  const sevenDay = db.state.sevenDay;
  const fiveHour = db.state.fiveHour;

  let pace = null;
  if (sevenDay && sevenDay.resetsAt) {
    const msLeft = sevenDay.resetsAt - now;
    const daysLeft = Math.max(1, Math.ceil(msLeft / DAY_MS));
    const weeklyLeft = Math.max(0, 100 - sevenDay.percent);
    pace = {
      daysLeft,
      weeklyLeft: +weeklyLeft.toFixed(1),
      // Even split of what's left over the days left in the weekly window.
      recommended: +(weeklyLeft / daysLeft).toFixed(1),
    };
  }

  return {
    date: key,
    config: db.config,
    today: {
      weekly: day.weekly,
      fiveHour: day.fiveHour,
      cost: day.cost,
      budget,
      remaining: +(budget - day.weekly).toFixed(2),
      ratio: budget > 0 ? +((day.weekly / budget) * 100).toFixed(1) : null,
      resetsAt: end,
    },
    limits: { fiveHour, sevenDay },
    pace,
    history: historyFrom(now),
  };
}

function setConfig(patch = {}) {
  const next = { ...db.config };
  if (typeof patch.budgetPercent === "number" && patch.budgetPercent > 0 && patch.budgetPercent <= 100) {
    next.budgetPercent = +patch.budgetPercent.toFixed(2);
  }
  if (Number.isInteger(patch.dayStartHour) && patch.dayStartHour >= 0 && patch.dayStartHour <= 23) {
    next.dayStartHour = patch.dayStartHour;
  }
  db.config = next;
  // Budget changed → the alert ladder for today has to be re-evaluated.
  const today = db.days[dayKey(Date.now())];
  if (today) today.alerted = 0;
  save();
  return db.config;
}

module.exports = { record, summary, setConfig, dayKey, BUDGET_THRESHOLDS };
