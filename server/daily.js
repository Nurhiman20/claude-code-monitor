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

// Cap on how far the between-ticks estimate may run ahead. It is waiting for a
// 1-point tick, so it must never claim a whole point on its own.
const MAX_FRAC = 0.9;
const RATE_SMOOTHING = 0.3;
const ROLLOVER_MARGIN_MS = 30 * 60000;

const EMPTY_EST = { frac: 0, costSinceTick: 0, rate: null };

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = {
  config: { ...DEFAULT_CONFIG },
  // Last sample of each account-wide window, used to compute increments.
  state: { fiveHour: null, sevenDay: null, costBySession: {}, weeklyEst: { ...EMPTY_EST } },
  days: {}, // "YYYY-MM-DD" -> { weekly, fiveHour, cost, firstAt, lastAt, alerted }
};

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    db = {
      config: { ...DEFAULT_CONFIG, ...(parsed.config || {}) },
      state: {
        fiveHour: null,
        sevenDay: null,
        costBySession: {},
        ...(parsed.state || {}),
        weeklyEst: { ...EMPTY_EST, ...(parsed.state?.weeklyEst || {}) },
      },
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
//
// Every open session reports the limits from its *own* last API response, so an
// idle session keeps sending stale numbers. Samples interleave (idle 14%, active
// 16%, idle 14%, ...) and following them blindly re-counts the same 2 points on
// every flip. The baseline therefore only ever moves forward: a lower percent or
// an older window is stale and ignored.
function windowDelta(name, next) {
  if (!next || typeof next.percent !== "number") return 0;
  const prev = db.state[name];
  const set = () => {
    db.state[name] = { percent: next.percent, resetsAt: next.resetsAt ?? null, at: Date.now() };
  };

  // First sample ever: only establish a baseline. Attributing the whole running
  // total to today would wildly overstate the first day of tracking.
  if (!prev) {
    set();
    return 0;
  }
  if (next.resetsAt && prev.resetsAt) {
    // Window rolled over — everything on the clock was burned inside the new window.
    // The margin absorbs jitter in how the reset time is reported.
    if (next.resetsAt > prev.resetsAt + ROLLOVER_MARGIN_MS) {
      set();
      return next.percent;
    }
    if (next.resetsAt < prev.resetsAt - ROLLOVER_MARGIN_MS) return 0; // from the previous window
  }
  if (next.percent <= prev.percent) return 0;
  set();
  return next.percent - prev.percent;
}

function costDelta(sessionId, total) {
  if (!sessionId || typeof total !== "number") return 0;
  const prev = db.state.costBySession[sessionId];
  db.state.costBySession[sessionId] = total;
  if (typeof prev !== "number") return total;
  return Math.max(0, total - prev);
}

// `used_percentage` arrives as a whole number, and the weekly window — the one the
// daily budget is measured against — only ticks once per ~1% of an entire week's
// allowance. Accumulating those ticks alone leaves the budget reading 0% for hours
// and then jumping. Cost moves with every message, so we learn how many weekly
// percent a dollar buys and use that to fill the gap between ticks. Every real tick
// reconciles against the estimate, so error never accumulates across ticks.
function weeklyDelta(next, spend) {
  const est = db.state.weeklyEst;
  const hadBaseline = Boolean(db.state.sevenDay);
  const stepped = windowDelta("sevenDay", next); // also refreshes db.state.sevenDay

  if (!next) return 0;
  if (!hadBaseline) {
    // First sample: no idea how much of the window is ours, so start the clock here.
    est.frac = 0;
    est.costSinceTick = 0;
    return 0;
  }

  if (stepped > 0) {
    const spent = est.costSinceTick + spend;
    if (spent > 0) {
      const observed = stepped / spent;
      est.rate = +(est.rate ? est.rate * (1 - RATE_SMOOTHING) + observed * RATE_SMOOTHING : observed).toFixed(6);
    }
    const credit = stepped - est.frac; // the estimate already banked `frac`
    est.frac = 0;
    est.costSinceTick = 0;
    return credit;
  }

  est.costSinceTick = +(est.costSinceTick + spend).toFixed(4);
  if (!est.rate || spend <= 0) return 0;
  const guess = Math.min(est.rate * spend, Math.max(0, MAX_FRAC - est.frac));
  est.frac = +(est.frac + guess).toFixed(4);
  return guess;
}

/**
 * Fold one usage sample into today's bucket.
 * @returns {{ key: string, day: object, crossed: number|null }} crossed = budget
 *   threshold (in % of budget) newly passed by this sample, if any.
 */
function record({ fiveHour, sevenDay, cost, sessionId, at = Date.now() }) {
  const key = dayKey(at);
  const day = getDay(key, at);

  const spend = costDelta(sessionId, cost);
  day.cost = +(day.cost + spend).toFixed(4);
  day.fiveHour = +(day.fiveHour + windowDelta("fiveHour", fiveHour)).toFixed(2);
  // A tick can reconcile the estimate downwards, so clamp instead of going negative.
  day.weekly = +Math.max(0, day.weekly + weeklyDelta(sevenDay, spend)).toFixed(2);
  // Sanity cap: if the weekly window opened no later than today did, today can't
  // have used more of it than the window has on its clock in total.
  const week = db.state.sevenDay;
  if (week?.resetsAt && week.resetsAt - 7 * DAY_MS <= dayBounds(at).start) {
    day.weekly = Math.min(day.weekly, +(week.percent + db.state.weeklyEst.frac).toFixed(2));
  }
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

  // Cumulative allowance: every day of the weekly window adds `budget` to the pot,
  // so under-use on earlier days carries over and over-use eats into today.
  // Days follow the window's own clock (its reset time), not dayStartHour.
  let allowance = null;
  if (sevenDay && sevenDay.resetsAt && budget > 0) {
    const windowStart = sevenDay.resetsAt - 7 * DAY_MS;
    const dayIndex = Math.min(6, Math.max(0, Math.floor((now - windowStart) / DAY_MS)));
    const total = +(budget * (dayIndex + 1)).toFixed(2);
    allowance = {
      dayIndex,
      total,
      left: +(total - sevenDay.percent).toFixed(2),
      resetsAt: windowStart + (dayIndex + 1) * DAY_MS,
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
      // Until the weekly window ticks once we have no cost→percent rate, so a 0
      // here means "not measured yet", not "nothing used".
      calibrating: !db.state.weeklyEst.rate && day.weekly === 0,
    },
    limits: { fiveHour, sevenDay },
    pace,
    allowance,
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
