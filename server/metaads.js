const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { telegramSend, desktopNotify } = require("./notifiers");

// Meta Ads watcher.
//
// Reads the ad account (read-only `ads_read` token, GET only) on a fixed WIB
// schedule and sends one Telegram report per slot: today's numbers, the phase
// so far, sales from the app, and — the point of the whole thing — a list of
// things the owner has to do, derived from the decision rules in the
// careerplan repo (`marketing/acquisition-system.md` > "Aturan keputusan
// Tahap 1"). Urgent problems (account blocked, ad rejected, ad set not
// delivering) are checked hourly around the clock and sent once per day.
//
// Message text is Indonesian and avoids em dashes, per the owner's copy rule.

const GRAPH = "https://graph.facebook.com/v24.0";
const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "metaads-state.json");
const HOUR = 3600000;
const DAY = 24 * HOUR;
const WIB = 7 * HOUR;
const TICK_MS = 5 * 60000;
const URGENT_EVERY_MS = HOUR;
const TELEGRAM_MAX = 4000;

const RESERVES = "K4b > K7 > K8, masing-masing sesuai pemicunya";

const ACCOUNT_STATUS = {
  2: "DISABLED (dinonaktifkan)",
  3: "UNSETTLED (tagihan belum lunas)",
  7: "PENDING_RISK_REVIEW (ditinjau Meta)",
  8: "PENDING_SETTLEMENT (menunggu pelunasan)",
  9: "IN_GRACE_PERIOD (masa tenggang tagihan)",
  100: "PENDING_CLOSURE (akan ditutup)",
  101: "CLOSED (ditutup)",
};

// --- Config ----------------------------------------------------------------

// The Meta token lives in the Windows *User* environment, not in .env. A
// server started before it was set doesn't inherit it, so fall back to
// reading the registry directly instead of demanding a restart.
function userEnv(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== "win32") return "";
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], {
      encoding: "utf8",
      windowsHide: true,
    });
    const match = out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`));
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

function num(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] !== "" ? value : fallback;
}

function config() {
  const env = process.env;
  return {
    enabled: env.META_ADS_MONITOR !== "0",
    token: userEnv("META_ACCESS_TOKEN"),
    account: userEnv("META_ACCOUNT_ID"),
    phaseName: env.META_PHASE_NAME || "Tahap 1",
    phaseStart: env.META_PHASE_START || "2026-10-16",
    phaseEnd: env.META_PHASE_END || "2026-10-22",
    phaseBudget: num("META_PHASE_BUDGET", 1000000),
    killCpl: num("META_KILL_CPL", 5000),
    winCpl: num("META_WIN_CPL", 1500),
    minSpend: num("META_MIN_SPEND", 50000),
    reportHours: (env.META_REPORT_HOURS || "7,10,13,16,19,22")
      .split(",")
      .map(Number)
      .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
      .sort((a, b) => a - b),
    statsUrl: env.HAPPI_STATS_URL || "https://www.happicareerplan.com/api/stats?days=7",
    salesUrl: env.HAPPI_SALES_URL || "https://www.happicareerplan.com/api/admin/sales",
    statsToken: env.HAPPI_STATS_TOKEN || "",
  };
}

// --- State -----------------------------------------------------------------

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let state = { lastSlot: null, lastUrgentAt: 0, failures: 0, alerted: {}, budgets: {} };

function load() {
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    // First run, or a corrupted file: start clean.
  }
}
load();

function save() {
  // Drop alert keys older than three days; they are only there to dedupe.
  const cutoff = wibDate(Date.now() - 3 * DAY);
  for (const [key, day] of Object.entries(state.alerted)) if (day < cutoff) delete state.alerted[key];
  fs.writeFile(FILE, JSON.stringify(state, null, 2), () => {});
}

// --- Time (always WIB, whatever the machine clock zone is) -------------------

function wibDate(ts) {
  return new Date(ts + WIB).toISOString().slice(0, 10);
}

function wibHour(ts) {
  return new Date(ts + WIB).getUTCHours();
}

function wibClock(ts) {
  return new Date(ts + WIB).toISOString().slice(11, 16).replace(":", ".");
}

// Midnight WIB of a "YYYY-MM-DD" date, as a UTC timestamp.
function wibMidnight(date) {
  return Date.parse(`${date}T00:00:00Z`) - WIB;
}

function phaseDay(cfg, now) {
  return Math.floor((wibMidnight(wibDate(now)) - wibMidnight(cfg.phaseStart)) / DAY) + 1;
}

function phaseLength(cfg) {
  return Math.round((wibMidnight(cfg.phaseEnd) - wibMidnight(cfg.phaseStart)) / DAY) + 1;
}

// The newest report slot at or before `now`: { key, at }.
function latestSlot(hours, now) {
  const today = wibDate(now);
  const hour = wibHour(now);
  const past = hours.filter((h) => h <= hour);
  if (past.length) {
    const h = past[past.length - 1];
    return { key: `${today} ${h}`, at: wibMidnight(today) + h * HOUR };
  }
  const yesterday = wibDate(now - DAY);
  const h = hours[hours.length - 1];
  return { key: `${yesterday} ${h}`, at: wibMidnight(yesterday) + h * HOUR };
}

// --- Formatting ------------------------------------------------------------

const rp = (n) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;
const int = (n) => Math.round(n).toLocaleString("id-ID");
const pct = (n, digits = 2) => `${n.toLocaleString("id-ID", { maximumFractionDigits: digits })}%`;
const cplText = (m) => (m.lead > 0 ? `${rp(m.spend / m.lead)}/Lead` : "belum ada Lead");

// --- Fetching --------------------------------------------------------------

async function graph(cfg, pathname, params = {}) {
  const url = new URL(`${GRAPH}/${pathname}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("access_token", cfg.token);

  const rows = [];
  let next = url.toString();
  for (let page = 0; next && page < 5; page++) {
    const res = await fetch(next, { signal: AbortSignal.timeout(30000) });
    const data = await res.json().catch(() => ({}));
    if (data.error) throw new Error(`Meta: ${data.error.message}`);
    if (!res.ok) throw new Error(`Meta HTTP ${res.status}`);
    if (!Array.isArray(data.data)) return data; // single object, no paging
    rows.push(...data.data);
    next = data.paging?.next || null;
  }
  return rows;
}

async function appJson(cfg, url) {
  if (!cfg.statsToken) return null;
  try {
    const res = await fetch(url, {
      headers: { "x-stats-token": cfg.statsToken },
      signal: AbortSignal.timeout(30000),
    });
    // 404 = endpoint not deployed yet; that section is simply left out.
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

const INSIGHT_FIELDS =
  "adset_id,adset_name,spend,impressions,cpm,inline_link_clicks,inline_link_click_ctr,actions";

function action(row, type) {
  const hit = (row.actions || []).find((a) => a.action_type === type);
  return hit ? Number(hit.value) || 0 : 0;
}

function metrics(row) {
  if (!row) return { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, lpv: 0, lead: 0 };
  return {
    spend: Number(row.spend) || 0,
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.inline_link_clicks) || 0,
    ctr: Number(row.inline_link_click_ctr) || 0,
    cpm: Number(row.cpm) || 0,
    lpv: action(row, "landing_page_view"),
    lead: action(row, "lead"),
  };
}

async function snapshot(cfg, now, { withAges = false } = {}) {
  if (!cfg.token || !cfg.account) throw new Error("META_ACCESS_TOKEN atau META_ACCOUNT_ID belum diisi");
  const act = cfg.account.startsWith("act_") ? cfg.account : `act_${cfg.account}`;
  const until = [wibDate(now), cfg.phaseEnd].sort()[0];
  const phaseRange = JSON.stringify({ since: cfg.phaseStart, until });

  const [account, adsets, ads, today, phase, ages, stats, sales] = await Promise.all([
    graph(cfg, act, { fields: "name,account_status,disable_reason,currency,timezone_name" }),
    graph(cfg, `${act}/adsets`, { fields: "id,name,effective_status,daily_budget", limit: "50" }),
    graph(cfg, `${act}/ads`, {
      fields: "name,effective_status,adset{name},ad_review_feedback",
      limit: "50",
    }),
    graph(cfg, `${act}/insights`, { level: "adset", date_preset: "today", fields: INSIGHT_FIELDS, limit: "50" }),
    graph(cfg, `${act}/insights`, { level: "adset", time_range: phaseRange, fields: INSIGHT_FIELDS, limit: "50" }),
    withAges
      ? graph(cfg, `${act}/insights`, {
          level: "account",
          time_range: phaseRange,
          breakdowns: "age",
          fields: "spend,inline_link_clicks,actions",
          limit: "50",
        })
      : null,
    appJson(cfg, cfg.statsUrl),
    appJson(cfg, `${cfg.salesUrl}?since=${cfg.phaseStart}`),
  ]);

  const byId = (rows) => new Map(rows.map((r) => [r.adset_id, r]));
  const todayById = byId(today);
  const phaseById = byId(phase);

  return {
    account,
    adsets: adsets.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.effective_status,
      budget: Number(s.daily_budget) || 0,
      today: metrics(todayById.get(s.id)),
      phase: metrics(phaseById.get(s.id)),
    })),
    ads: ads.map((a) => ({
      name: a.name,
      status: a.effective_status,
      adset: a.adset?.name || "",
      feedback: Object.values(a.ad_review_feedback?.global || {}).join("; "),
    })),
    ages: ages ? ages.map((r) => ({ age: r.age, spend: Number(r.spend) || 0, clicks: Number(r.inline_link_clicks) || 0, lead: action(r, "lead") })) : null,
    stats: stats && !stats.error ? stats : null,
    sales: sales && !sales.error ? sales : null,
  };
}

// --- Rules -----------------------------------------------------------------

const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);

function total(list, key) {
  return {
    spend: sum(list, (s) => s[key].spend),
    impressions: sum(list, (s) => s[key].impressions),
    clicks: sum(list, (s) => s[key].clicks),
    lpv: sum(list, (s) => s[key].lpv),
    lead: sum(list, (s) => s[key].lead),
  };
}

/**
 * Pure: snapshot in, verdicts out. `prevBudgets` is the last seen daily budget
 * per ad set, to catch mid-phase budget edits (each one restarts learning).
 */
function evaluate(cfg, snap, now, prevBudgets = {}) {
  const day = phaseDay(cfg, now);
  const length = phaseLength(cfg);
  const active = snap.adsets.filter((s) => s.status === "ACTIVE");
  const paused = snap.adsets.filter((s) => s.status !== "ACTIVE");
  const actions = [];
  const urgent = []; // { key, text } — also sent outside the report schedule
  const notes = [];
  const labels = new Map();

  // Decision rule: judged per ad set once it has run 2 days and spent ~Rp 50.000.
  const evaluable = (s) => day >= 2 && s.phase.spend >= cfg.minSpend;
  const cpl = (m) => (m.lead > 0 ? m.spend / m.lead : Infinity);

  for (const s of snap.adsets) {
    if (s.status !== "ACTIVE") labels.set(s.id, s.status === "PAUSED" || s.status === "CAMPAIGN_PAUSED" ? "mati" : s.status);
    else if (!evaluable(s)) labels.set(s.id, "belum dinilai");
    else if (s.phase.lead === 0) labels.set(s.id, "MATIKAN");
    else if (cpl(s.phase) > cfg.killCpl) labels.set(s.id, "MATIKAN");
    else if (cpl(s.phase) < cfg.winCpl) labels.set(s.id, "pemenang");
    else labels.set(s.id, "biarkan");
  }

  for (const s of active) {
    if (labels.get(s.id) !== "MATIKAN") continue;
    actions.push(
      s.phase.lead === 0
        ? `MATIKAN ${s.name}: ${rp(s.phase.spend)} tanpa satu Lead. Pause saja, jangan langsung ganti. Cadangan: ${RESERVES}.`
        : `MATIKAN ${s.name}: ${rp(cpl(s.phase))}/Lead, di atas ${rp(cfg.killCpl)}. Pause saja, jangan langsung ganti. Cadangan: ${RESERVES}.`
    );
  }

  const judged = active.filter(evaluable);
  if (judged.length && judged.length === active.length && judged.every((s) => cpl(s.phase) > cfg.killCpl)) {
    actions.push(
      `${cfg.phaseName} gagal: semua ad set di atas ${rp(cfg.killCpl)}/Lead. Stop semua, ganti kreatif cadangan, ulang minggu berikutnya.`
    );
  }

  const phaseTotal = total(snap.adsets, "phase");
  if (day >= 5 && day <= length && active.length >= 5 && phaseTotal.spend >= cfg.phaseBudget * 0.75) {
    const worst = [...active].sort((a, b) => cpl(b.phase) - cpl(a.phase)).slice(0, 2);
    actions.push(
      `Hari ke-${day} dan sudah ${rp(phaseTotal.spend)} terpakai dengan 5 ad set hidup: matikan dua termahal, ${worst.map((s) => s.name).join(" dan ")}.`
    );
  }

  if (phaseTotal.spend >= cfg.phaseBudget) {
    actions.push(`Budget ${cfg.phaseName} habis (${rp(phaseTotal.spend)} dari ${rp(cfg.phaseBudget)}). Hentikan semua ad set.`);
  } else if (phaseTotal.spend >= cfg.phaseBudget * 0.9) {
    actions.push(`Budget ${cfg.phaseName} hampir habis: ${rp(phaseTotal.spend)} dari ${rp(cfg.phaseBudget)}.`);
  }

  for (const s of active) {
    const prev = prevBudgets[s.id];
    if (prev && s.budget && prev !== s.budget) {
      urgent.push({
        key: `budget:${s.id}:${s.budget}`,
        text: `Budget ${s.name} berubah ${rp(prev)} ke ${rp(s.budget)}/hari. Itu mengulang learning phase. Aturan tahap: jangan ubah budget ad set yang jalan, cukup matikan atau buat ad set baru.`,
      });
    }
  }

  // Tracking check: Meta Lead vs results the site recorded from `utm_source=meta`.
  const meta = snap.stats?.by_source?.find((r) => r.source === "meta");
  if (meta && phaseTotal.lead >= 10) {
    const gap = Math.abs(phaseTotal.lead - meta.generate) / Math.max(phaseTotal.lead, meta.generate);
    if (gap > 0.2) {
      actions.push(
        `Lead Meta ${phaseTotal.lead} vs hasil situs dari meta ${meta.generate} (selisih ${pct(gap * 100, 0)}). Cek tracking Pixel/CAPI dulu sebelum menilai iklan.`
      );
    }
  }

  const salesMeta = snap.sales?.by_source?.find((r) => r.source === "meta");
  if (day > length) {
    const cost = phaseTotal.lead ? phaseTotal.spend / phaseTotal.lead : null;
    const income = salesMeta && phaseTotal.lead ? salesMeta.amount / phaseTotal.lead : null;
    let verdict = "Bandingkan rupiah masuk per Lead dengan biaya per Lead.";
    if (cost && income !== null) {
      verdict =
        income > cost
          ? `Rupiah masuk ${rp(income)}/Lead > biaya ${rp(cost)}/Lead: naikkan budget pemenang 20 sampai 30% tiap 3 hari.`
          : `Rupiah masuk ${rp(income)}/Lead <= biaya ${rp(cost)}/Lead: jangan tambah budget, perbaiki konversi dulu.`;
    }
    actions.push(`${cfg.phaseName} selesai ${cfg.phaseEnd}. Saatnya keputusan tahap berikutnya. ${verdict} Lalu perbarui META_PHASE_* di .env monitor.`);
  }

  if ((snap.sales?.pending_today || 0) >= 3) {
    actions.push(`${snap.sales.pending_today} pembayaran menggantung hari ini. Hubungi pembelinya.`);
  }

  // Urgent: problems that cost money or stop delivery right now.
  const status = Number(snap.account?.account_status);
  if (status && status !== 1) {
    urgent.push({
      key: `account:${status}`,
      text: `Akun iklan bermasalah: ${ACCOUNT_STATUS[status] || `status ${status}`}. Cek Ads Manager dan metode pembayaran.`,
    });
  }
  for (const ad of snap.ads) {
    if (ad.status === "DISAPPROVED" || ad.status === "WITH_ISSUES") {
      urgent.push({
        key: `ad:${ad.name}:${ad.status}`,
        text: `Iklan ${ad.name} ${ad.status === "DISAPPROVED" ? "ditolak" : "bermasalah"}${ad.feedback ? `: ${ad.feedback}` : ""}. Cek Ads Manager.`,
      });
    }
  }
  for (const s of snap.adsets) {
    if (s.status === "WITH_ISSUES") {
      urgent.push({ key: `adset:${s.id}:issues`, text: `Ad set ${s.name} bermasalah (WITH_ISSUES). Cek Ads Manager.` });
    }
  }
  if (wibHour(now) >= 10) {
    for (const s of active) {
      if (s.today.impressions === 0) {
        urgent.push({ key: `stall:${s.id}`, text: `${s.name} aktif tapi belum tayang sama sekali hari ini.` });
      }
    }
  }

  // Diagnosis notes, from "Diagnosis kalau iklan mahal".
  if (!judged.length && active.length) {
    notes.push(`Belum ada yang bisa dinilai: ad set dinilai mulai hari ke-2 dan sesudah ${rp(cfg.minSpend)}. Jangan matikan apa pun dulu.`);
  }
  const hook = active.filter((s) => s.phase.impressions >= 500 && s.phase.ctr < 0.8);
  if (hook.length) notes.push(`CTR di bawah 0,8%: ${hook.map((s) => s.name).join(", ")}. Hook kurang menarik, pembukanya yang perlu diganti.`);
  const noLead = active.filter((s) => s.phase.clicks >= 5 && s.phase.ctr >= 2 && s.phase.lead === 0);
  if (noLead.length) notes.push(`CTR tinggi tanpa Lead: ${noLead.map((s) => s.name).join(", ")}. Klik belum jadi Lead, cek janji iklan vs halaman.`);
  const lost = active.filter((s) => s.phase.clicks >= 5 && s.phase.lpv / s.phase.clicks < 0.6);
  for (const s of lost) {
    notes.push(`${s.name}: ${s.phase.clicks} klik tapi cuma ${s.phase.lpv} LPV. Banyak yang pergi sebelum halaman termuat, cek kecepatan landing page.`);
  }
  const cpms = active.map((s) => s.today.cpm).filter((c) => c > 0);
  if (day <= 3 && cpms.length >= 2 && Math.max(...cpms) > 2 * Math.min(...cpms)) {
    notes.push(`CPM lebar (${int(Math.min(...cpms))} s.d. ${int(Math.max(...cpms))}), wajar di fase belajar.`);
  }
  if (meta && meta.generate >= 10 && meta.pay_success === 0) {
    notes.push(`${meta.generate} hasil dari meta tapi belum ada pembelian. Bukan masalah iklan: cek halaman hasil dan pembayaran.`);
  }
  if (snap.ages) {
    const young = snap.ages.filter((a) => a.age === "13-17" || a.age === "18-24");
    const allSpend = sum(snap.ages, (a) => a.spend);
    const youngSpend = sum(young, (a) => a.spend);
    if (allSpend > 0 && youngSpend / allSpend > 0.2) {
      notes.push(`${pct((youngSpend / allSpend) * 100, 0)} spend jatuh ke umur di bawah 25 (Advantage+ melebar). Pantau apakah Lead-nya membayar, jangan ubah ad set yang jalan.`);
    }
  }
  if (paused.length) notes.push(`Tidak aktif: ${paused.map((s) => `${s.name} (${s.status})`).join(", ")}.`);

  return { day, length, actions, urgent, notes, labels, phaseTotal, salesMeta };
}

// --- Message ---------------------------------------------------------------

function adsetLine(s, key, label) {
  const m = s[key];
  const lines = [`${s.name}${label ? ` [${label}]` : ""}: ${rp(m.spend)}`];
  lines.push(`  klik ${m.clicks} · CTR ${pct(m.ctr)} · LPV ${m.lpv} · Lead ${m.lead} · ${cplText(m)}`);
  return lines.join("\n");
}

function compose(cfg, snap, verdict, now, { urgentOnly = false } = {}) {
  const { day, length, actions, urgent, notes, labels, phaseTotal, salesMeta } = verdict;
  const out = [];
  const dayLabel = day > length ? `selesai (hari ke-${day})` : `hari ke-${day}`;
  out.push(`📊 Meta Ads · ${cfg.phaseName} ${dayLabel} · ${wibClock(now)} WIB`);

  const todo = [...urgent.map((u) => u.text), ...actions];
  if (todo.length) {
    out.push("", "⚠️ PERLU TINDAKAN");
    todo.forEach((t, i) => out.push(`${i + 1}. ${t}`));
  } else if (!urgentOnly) {
    out.push("", "✅ Tidak ada yang perlu dilakukan sekarang.");
  }
  if (urgentOnly) return out.join("\n");

  const byPhaseCpl = (a, b) =>
    (a.phase.lead ? a.phase.spend / a.phase.lead : Infinity) - (b.phase.lead ? b.phase.spend / b.phase.lead : Infinity);
  const sets = [...snap.adsets].sort(byPhaseCpl);

  const t = total(snap.adsets, "today");
  if (day <= length) {
    out.push("", `HARI INI: ${rp(t.spend)}, ${t.lead} Lead, ${t.lead ? `${rp(t.spend / t.lead)}/Lead` : "belum ada Lead"}`);
    for (const s of sets.filter((s) => s.status === "ACTIVE" || s.today.spend > 0)) out.push(adsetLine(s, "today"));
  }

  const used = cfg.phaseBudget ? ` dari ${rp(cfg.phaseBudget)} (${pct((phaseTotal.spend / cfg.phaseBudget) * 100, 0)})` : "";
  out.push(
    "",
    `${cfg.phaseName.toUpperCase()} s.d. hari ini: ${rp(phaseTotal.spend)}${used}`,
    `${phaseTotal.lead} Lead, ${phaseTotal.lead ? `${rp(phaseTotal.spend / phaseTotal.lead)}/Lead` : "belum ada Lead"}. Ambang: > ${rp(cfg.killCpl)} matikan, < ${rp(cfg.winCpl)} pemenang.`
  );
  // On day 1 the phase so far *is* today; listing it twice is noise.
  if (day > 1) {
    for (const s of sets.filter((s) => s.phase.spend > 0 || s.status === "ACTIVE")) out.push(adsetLine(s, "phase", labels.get(s.id)));
  }

  const meta = snap.stats?.by_source?.find((r) => r.source === "meta");
  if (meta) {
    out.push("", `SITUS (7 hari, kanal meta): ${meta.generate} hasil, ${meta.pay_success} bayar. Lead Meta tahap ini ${phaseTotal.lead}.`);
    // Full funnel only once the app reports it per channel (since 16 Okt 2026).
    if (meta.gate_viewed !== undefined) {
      out.push(`Corong: ${meta.gate_viewed} lihat tawaran · ${meta.pay_clicked} klik bayar · ${meta.pay_started} mulai bayar · ${meta.pay_success} lunas`);
      const reasons = Object.entries(meta.feedback || {})
        .filter(([key]) => key.startsWith("skip_"))
        .sort((a, b) => b[1] - a[1])
        .map(([key, n]) => `${key.slice(5)} ${n}`);
      if (reasons.length) out.push(`Alasan belum bayar: ${reasons.join(", ")}`);
    }
  }

  if (snap.sales) {
    const s = snap.sales;
    out.push("", "PENJUALAN (iPaymu)");
    out.push(`Hari ini: ${s.today.count} pembelian, ${rp(s.today.amount)}`);
    out.push(
      `${cfg.phaseName}: ${s.since_total.count} pembelian, ${rp(s.since_total.amount)}${salesMeta ? ` · dari meta ${salesMeta.count}, ${rp(salesMeta.amount)}` : ""}`
    );
    if (salesMeta && phaseTotal.lead) {
      const income = salesMeta.amount / phaseTotal.lead;
      const cost = phaseTotal.spend / phaseTotal.lead;
      out.push(`Rupiah masuk per Lead: ${rp(income)} vs biaya ${rp(cost)}/Lead ${income > cost ? "✅" : "❌"}`);
    }
  }

  if (snap.ages) {
    const allSpend = sum(snap.ages, (a) => a.spend);
    out.push("", "UMUR (spend · klik · Lead)");
    for (const a of snap.ages) {
      out.push(`${a.age}: ${allSpend ? pct((a.spend / allSpend) * 100, 0) : "0%"} · ${a.clicks} · ${a.lead}`);
    }
  }

  if (notes.length) {
    out.push("", "CATATAN");
    for (const n of notes) out.push(`- ${n}`);
  }

  let text = out.join("\n");
  if (text.length > TELEGRAM_MAX) text = `${text.slice(0, TELEGRAM_MAX - 20)}\n… (dipotong)`;
  return text;
}

// --- Runs ------------------------------------------------------------------

let running = false;

function rememberBudgets(snap) {
  for (const s of snap.adsets) if (s.budget) state.budgets[s.id] = s.budget;
}

// Urgent items not yet sent today; marks them sent.
function freshUrgent(urgent, now) {
  const today = wibDate(now);
  const fresh = urgent.filter((u) => state.alerted[u.key] !== today);
  for (const u of fresh) state.alerted[u.key] = today;
  return fresh;
}

async function failed(cfg, error, now) {
  state.failures = (state.failures || 0) + 1;
  console.error("[metaads]", error.message);
  if (state.failures >= 2) {
    const [fresh] = freshUrgent([{ key: "fetch-failed", text: error.message }], now);
    if (fresh) await telegramSend(`⚠️ Pemantau Meta Ads tidak bisa membaca data (${state.failures}x berturut-turut): ${error.message}`);
  }
  save();
}

/**
 * Full report. `dryRun` returns the text without sending or touching state;
 * `fixture` ({ now, snap }) skips the network, for testing the rules.
 */
async function report({ manual = false, dryRun = false, fixture = null } = {}) {
  const cfg = config();
  const now = fixture?.now ?? Date.now();
  const day = phaseDay(cfg, now);
  let snap;
  try {
    snap = fixture?.snap ?? (await snapshot(cfg, now, { withAges: day === 2 || day === 3 }));
  } catch (e) {
    if (dryRun) throw e;
    await failed(cfg, e, now);
    if (manual) await telegramSend(`Gagal ambil data Meta: ${e.message}`);
    return null;
  }

  const verdict = evaluate(cfg, snap, now, dryRun ? fixture?.budgets || {} : state.budgets);
  const text = compose(cfg, snap, verdict, now);
  if (dryRun) return text;

  state.failures = 0;
  state.lastUrgentAt = now;
  freshUrgent(verdict.urgent, now); // they're in this report; don't resend within the hour
  rememberBudgets(snap);
  save();

  await telegramSend(text);
  if (verdict.actions.length || verdict.urgent.length) {
    desktopNotify("Meta Ads: perlu tindakan", [...verdict.urgent.map((u) => u.text), ...verdict.actions][0]);
  }
  return text;
}

async function urgentCheck(now) {
  const cfg = config();
  let snap;
  try {
    snap = await snapshot(cfg, now);
  } catch (e) {
    await failed(cfg, e, now);
    return;
  }
  state.failures = 0;
  const verdict = evaluate(cfg, snap, now, state.budgets);
  const fresh = freshUrgent(verdict.urgent, now);
  rememberBudgets(snap);
  save();
  if (!fresh.length) return;
  await telegramSend(compose(cfg, snap, { ...verdict, urgent: fresh, actions: [] }, now, { urgentOnly: true }));
  desktopNotify("Meta Ads: mendesak", fresh[0].text);
}

async function tick() {
  const cfg = config();
  if (!cfg.enabled || running || !cfg.reportHours.length) return;
  running = true;
  try {
    const now = Date.now();
    const slot = latestSlot(cfg.reportHours, now);
    // Only the newest slot, and only while it's still fresh: waking the laptop
    // at 06.00 must not fire last night's 22.00 report.
    if (state.lastSlot !== slot.key && now - slot.at < 3 * HOUR) {
      state.lastSlot = slot.key;
      save();
      await report();
    } else if (now - (state.lastUrgentAt || 0) >= URGENT_EVERY_MS) {
      state.lastUrgentAt = now;
      await urgentCheck(now);
    }
  } catch (e) {
    console.error("[metaads tick failed]", e.message);
  } finally {
    running = false;
  }
}

function start() {
  if (!config().enabled) return;
  setTimeout(tick, 15000).unref?.();
  setInterval(tick, TICK_MS).unref?.();
}

module.exports = { start, report, evaluate, compose, latestSlot, phaseDay };
