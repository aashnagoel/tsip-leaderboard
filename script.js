// =============================================================================
// TSIP Leaderboard — script.js
// =============================================================================
// Reads task scores live from a Google Sheet, computes the Full Task
// leaderboard, gamifies performance with a top-performers podium,
// lets contributors flag "you" to track their own rank, and lets admins overlay
// corrections and snapshot weekly archives via Firestore.

// -----------------------------------------------------------------------------
// CONSTANTS — paste your Firebase config below; everything else is set per spec.
// -----------------------------------------------------------------------------

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDFE8aGXlP0i8GrmFMnZs3DJq1mpxa6S40",
  authDomain:        "tsip-leaderboard-664a5.firebaseapp.com",
  projectId:         "tsip-leaderboard-664a5",
  storageBucket:     "tsip-leaderboard-664a5.firebasestorage.app",
  messagingSenderId: "1033225497363",
  appId:             "1:1033225497363:web:bb953bba32ff81cfdc88e6",
};

// Casual gate visible in page source — accept the tradeoff for an internal tool.
const ADMIN_PASSWORD = "Meridian_Admin_26";

// Starter sheet for first run. After that, meta.currentSheetId in Firestore wins.
const DEFAULT_SHEET_ID = "1X1GLMnTU8mP90g1dydgy39YkL_nhcrqXkH9LhcjoDFE";

// Full Task is the default tab of the claim sheet, so we fetch it by gid (the
// "gid=0" in the sheet URL) rather than by exact tab name. This makes us immune
// to the tab being titled "Full Task" vs "Full Tasks" etc.
const FULL_TASK_GID = "0";
// Sheet columns. Prefer header names so the board survives inserted/reordered
// columns; fall back to the current known positions if a CSV has no headers.
const FULL = {
  name: { headers: ["Claimed By"], fallback: 1 },
  redo: { headers: ["DO NOT EDIT Needs Re-do", "Needs Re-do"], fallback: 3 },
  done: { headers: ["Done"], fallback: 11 },
  dateDone: { headers: ["Date Done"], fallback: 13 },
  redoDone: { headers: ["REDO DONE", "Redo Done"], fallback: 21 },
  secondRedoDone: { headers: ["SECOND REDO DONE", "Second Redo Done", "2ND REDO DONE", "2nd Redo Done"], fallback: null },
};
const RUBRIC = {
  name: { headers: ["Claimed By"], fallback: 1 },
  redo: { headers: ["DO NOT EDIT Needs Re-do", "Needs Re-do"], fallback: 3 },
  done: { headers: ["Done"], fallback: 6 },
  dateDone: { headers: ["Date Done"], fallback: 7 },
  redoDone: { headers: ["REDO DONE", "Redo Done"], fallback: 12 },
};

const DROP_NAMES   = ["DO NOT CLAIM"];
const NAME_ALIASES = {};  // built-in static aliases; runtime aliases come from Firestore
const ASSUME_YEAR  = 2026;

// localStorage keys.
const LS_ME    = "tsip_me_v1";       // nameKey of the viewer
const LS_TREND = "tsip_trend_v1";    // last-visit standings snapshot

// -----------------------------------------------------------------------------
// Firebase modular SDK v12.11.0 — ES module imports from official CDN.
// -----------------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc,
  onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";

// -----------------------------------------------------------------------------
// State.
// -----------------------------------------------------------------------------

const state = {
  fb: { app: null, db: null, status: "connecting", error: null },
  sheet: {
    id: null,
    raw: null,                 // { fullRows, rubricRows }
    base: null,                // { fullTask: Map, rubric: Map }
    fetching: false,
    error: null,
    lastFetched: null,
  },
  meta:     null,
  overlays: {},
  aliases:  {},
  archives: [],
  archiveCache: {},
  ui: {
    tab:  "fullTask",
    view: "live",              // "live" | <archive doc id>
  },
  admin: { unlocked: false, name: sessionStorage.getItem("tsip_admin_name") || "" },
  me: localStorage.getItem(LS_ME) || null,   // viewer identity (nameKey)
  trendBaseline: null,         // { ranks: { fullTask:{k:rank}, rubric:{k:rank} }, savedAt }
  confettiFired: false,
};

// -----------------------------------------------------------------------------
// Small helpers.
// -----------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function $(id) { return document.getElementById(id); }

function showToast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (kind ? " " + kind : "");
  t.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

function openModal(id)  { const el = $(id); if (el) el.hidden = false; }
function closeModal(id) { const el = $(id); if (el) el.hidden = true;  }

document.addEventListener("click", (e) => {
  const closeId = e.target?.dataset?.close;
  if (closeId) closeModal(closeId);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  ["picker-modal", "overlay-edit-modal", "swap-modal", "history-modal", "password-modal", "admin-modal"]
    .forEach((id) => { const el = $(id); if (el && !el.hidden) closeModal(id); });
});

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
// -----------------------------------------------------------------------------
// CSV parser (handles quoted fields, embedded newlines, escaped quotes).
// -----------------------------------------------------------------------------

function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c === "\r") { /* skip */ }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function csvUrlByGid(sheetId, gid) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}`;
}
function csvUrlByName(sheetId, tabName) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
}

// -----------------------------------------------------------------------------
// Name normalization, date parsing, truthy.
// -----------------------------------------------------------------------------

function normalizeNameRaw(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw).trim().replace(/\s+/g, " ");
}
function applyAlias(displayName) {
  if (!displayName) return null;
  const k = displayName.toLowerCase();
  if (state.aliases[k]?.canonical) return state.aliases[k].canonical;
  if (NAME_ALIASES[displayName])   return NAME_ALIASES[displayName];
  return displayName;
}
function nameKey(displayName) { return displayName ? displayName.toLowerCase() : null; }
function truthyFlag(v) { return String(v ?? "").trim().toUpperCase() === "TRUE"; }

function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const month = parseInt(m[1], 10), day = parseInt(m[2], 10);
  let year;
  if (m[3]) { const y = parseInt(m[3], 10); year = y < 100 ? 2000 + y : y; }
  else year = ASSUME_YEAR;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// -----------------------------------------------------------------------------
// Firebase init + status pill.
// -----------------------------------------------------------------------------

function setStatus(status, err) {
  state.fb.status = status;
  state.fb.error  = err?.message || null;
  renderStatus();
}

function renderStatus() {
  const pill = $("fb-status");
  if (!pill) return;
  pill.className = "status-pill status-" + state.fb.status;
  pill.textContent = ({
    connecting: "Firebase: connecting…",
    connected:  "Firebase: connected",
    error:      "Firebase: not connected",
  })[state.fb.status];
  pill.title = state.fb.status === "error"
    ? "Click to see the error" + (state.fb.error ? "\n\n" + state.fb.error : "")
    : "";
  const adminLink = $("admin-link");
  if (adminLink) {
    if (state.fb.status === "error") {
      adminLink.disabled = true; adminLink.textContent = "Admin (unavailable)";
      adminLink.title = "Admin features unavailable — Firebase not connected";
    } else {
      adminLink.disabled = false; adminLink.textContent = "Admin"; adminLink.title = "";
    }
  }
}

document.addEventListener("click", (e) => {
  if (e.target?.id === "fb-status" && state.fb.status === "error") {
    alert("Firebase didn't connect:\n\n" + (state.fb.error || "(no error message)"));
  }
});

function initFirebase() {
  try {
    state.fb.app = initializeApp(FIREBASE_CONFIG);
    state.fb.db  = getFirestore(state.fb.app);
    setStatus("connecting");
  } catch (err) {
    console.error("[Firebase] init threw:", err);
    setStatus("error", err);
  }
}

async function probeFirebase() {
  if (!state.fb.db) return;
  try {
    const snap = await getDoc(doc(state.fb.db, "meta", "site"));
    if (snap.exists()) {
      state.meta = snap.data();
      console.log("[Firebase] connected, meta doc found");
    } else {
      console.log("[Firebase] connected, no meta doc yet (first run)");
      const seed = { currentSheetId: DEFAULT_SHEET_ID, schemaVersion: 1, updatedAt: serverTimestamp() };
      await setDoc(doc(state.fb.db, "meta", "site"), seed);
      state.meta = { currentSheetId: DEFAULT_SHEET_ID, schemaVersion: 1 };
    }
    setStatus("connected");
  } catch (err) {
    console.error("[Firebase] CONNECTION FAILED:", err);
    setStatus("error", err);
  }
}

// -----------------------------------------------------------------------------
// Sheet fetch.
// -----------------------------------------------------------------------------

async function fetchCsv(url, what) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${what}. Make sure the sheet is shared "Anyone with the link can view".`);
  const text = await res.text();
  // gviz sometimes returns an HTML error page with status 200 for a bad tab.
  if (/^\s*</.test(text)) throw new Error(`${what} returned a non-CSV response (tab may not exist).`);
  return text;
}

function looksLikeSameSheet(aHeaders, aRows, bHeaders, bRows) {
  const sameHeaders = JSON.stringify(aHeaders || []) === JSON.stringify(bHeaders || []);
  const sameFirstTask = (aRows?.[0]?.[0] || "") && (aRows?.[0]?.[0] || "") === (bRows?.[0]?.[0] || "");
  const sameRowCount = (aRows || []).length === (bRows || []).length;
  return sameHeaders && sameFirstTask && sameRowCount;
}

async function loadSheet(sheetId) {
  if (!sheetId) return;
  state.sheet.id = sheetId;
  state.sheet.fetching = true;
  state.sheet.error = null;
  renderFetchState();

  // Full Task is required (fetched by gid).
  let fullCsv;
  try {
    fullCsv = await fetchCsv(csvUrlByGid(sheetId, FULL_TASK_GID), "Full Task tab");
  } catch (err) {
    console.error("[sheet] Full Task fetch failed:", err);
    state.sheet.error = err.message;
    state.sheet.fetching = false;
    renderAll();
    return;
  }

  const fullParsed = parseCsv(fullCsv);
  const fullHeaders = fullParsed[0] || [];
  const fullRows = fullParsed.slice(1);

  const rubricRows = [];
  const rubricHeaders = [];

  state.sheet.raw = { fullRows, rubricRows, fullHeaders, rubricHeaders };
  state.sheet.base = {
    fullTask: scoreRows(fullRows,   FULL,   "fullTask", fullHeaders),
    rubric:   scoreRows(rubricRows, RUBRIC, "rubric", rubricHeaders),
  };
  state.sheet.lastFetched = new Date();
  state.sheet.error = null;
  state.sheet.fetching = false;
  logScores(state.sheet.base);
  renderAll();
}

// -----------------------------------------------------------------------------
// Scoring — one row = one task, per spec.
// -----------------------------------------------------------------------------

function normalizeHeaderName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveColumn(headers, spec) {
  if (typeof spec === "number") return spec;
  const normalized = (headers || []).map(normalizeHeaderName);
  for (const header of spec.headers || []) {
    const idx = normalized.indexOf(normalizeHeaderName(header));
    if (idx !== -1) return idx;
  }
  return spec.fallback;
}

function resolveColumns(headers, cfg) {
  return Object.fromEntries(Object.entries(cfg).map(([key, spec]) => [key, resolveColumn(headers, spec)]));
}

function cell(row, idx) {
  return idx == null ? "" : (row[idx] || "");
}

function scoreRows(rows, cfg, tabKey, headers = []) {
  const cols = resolveColumns(headers, cfg);
  const buckets = new Map();
  for (const row of rows) {
    if (!row || !row.length) continue;
    const rawName = cell(row, cols.name).trim();
    if (!rawName) continue;
    const aliased = applyAlias(normalizeNameRaw(rawName));
    if (!aliased) continue;
    if (DROP_NAMES.some((d) => d.toLowerCase() === aliased.toLowerCase())) continue;

    const k = nameKey(aliased);
    let b = buckets.get(k);
    if (!b) { b = { displayName: aliased, completed: 0, outstandingRedo: 0, redoCounter: 0, rows: [] }; buckets.set(k, b); }

    const done       = truthyFlag(cell(row, cols.done));
    const isRedo     = cell(row, cols.redo).trim().toUpperCase() === "REDO";
    const redoDone   = truthyFlag(cell(row, cols.redoDone));
    const secondDone = cols.secondRedoDone != null && truthyFlag(cell(row, cols.secondRedoDone));

    if (done) b.completed++;
    if (isRedo && !redoDone) b.outstandingRedo++;
    if (isRedo) b.redoCounter++;
    if (secondDone) b.redoCounter++;

    const rawDateDone = cell(row, cols.dateDone).trim();
    b.rows.push({
      taskId: (row[0] || "").trim().slice(0, 8),
      date:   normalizeDate(rawDateDone) || rawDateDone || null,
      done, isRedo, redoDone, secondRedoDone: secondDone,
    });
  }
  return buckets;
}

function logScores(base) {
  console.groupCollapsed("[scoring] Full Task");
  for (const [, v] of base.fullTask) {
    console.log(`  ${v.displayName}: completed=${v.completed}, outstanding=${v.outstandingRedo}, net=${Math.max(0, v.completed - v.outstandingRedo)}, redoCounter=${v.redoCounter}`);
  }
  console.groupEnd();
}

function rescore() {
  if (!state.sheet.raw) return;
  state.sheet.base = {
    fullTask: scoreRows(state.sheet.raw.fullRows,   FULL,   "fullTask", state.sheet.raw.fullHeaders),
    rubric:   scoreRows(state.sheet.raw.rubricRows, RUBRIC, "rubric", state.sheet.raw.rubricHeaders),
  };
}

// -----------------------------------------------------------------------------
// Apply overlays.
// -----------------------------------------------------------------------------

function applyOverlaysToBoard(baseMap, tabKey) {
  const final = new Map();
  for (const [k, b] of baseMap) {
    const ov = state.overlays[k] || null;
    const ovTab = ov?.[tabKey] || {};
    const displayName = ov?.displayName || b.displayName;
    const completed   = (ovTab.completed   != null) ? ovTab.completed   : b.completed;
    const redoCounter = (ovTab.redoCounter != null) ? ovTab.redoCounter : b.redoCounter;
    final.set(k, {
      displayName, completed, redoCounter,
      outstandingRedo: b.outstandingRedo,
      baseCompleted: b.completed, baseRedoCounter: b.redoCounter,
      hasCompletedOverlay: ovTab.completed   != null,
      hasRedoOverlay:      ovTab.redoCounter != null,
      netScore: Math.max(0, completed - b.outstandingRedo),
      rows: b.rows,
      adjustments: ov?.adjustments || [],
    });
  }
  for (const [k, ov] of Object.entries(state.overlays)) {
    if (final.has(k)) continue;
    if (!ov.addedByOverlayOnly) continue;
    const ovTab = ov[tabKey] || {};
    const completed   = ovTab.completed   ?? 0;
    const redoCounter = ovTab.redoCounter ?? 0;
    final.set(k, {
      displayName: ov.displayName,
      completed, redoCounter, outstandingRedo: 0,
      baseCompleted: 0, baseRedoCounter: 0,
      hasCompletedOverlay: ovTab.completed   !== undefined,
      hasRedoOverlay:      ovTab.redoCounter !== undefined,
      netScore: Math.max(0, completed),
      rows: [], adjustments: ov.adjustments || [],
    });
  }
  return final;
}

function combineBoards(fullMap, rubricMap) {
  const keys = new Set([...fullMap.keys(), ...rubricMap.keys()]);
  const out = new Map();
  for (const k of keys) {
    const f = fullMap.get(k), r = rubricMap.get(k);
    out.set(k, {
      displayName: f?.displayName || r?.displayName || k,
      fullTaskNet: f?.netScore || 0, rubricNet: r?.netScore || 0,
      fullTaskRedos: f?.redoCounter || 0, rubricRedos: r?.redoCounter || 0,
      totalRedos: (f?.redoCounter || 0) + (r?.redoCounter || 0),
      score: (f?.netScore || 0) + (r?.netScore || 0),
    });
  }
  return out;
}

function deriveFinalBoards() {
  if (!state.sheet.base) return { fullTask: new Map(), rubric: new Map(), combined: new Map() };
  const fullFinal   = applyOverlaysToBoard(state.sheet.base.fullTask, "fullTask");
  const rubricFinal = applyOverlaysToBoard(state.sheet.base.rubric,   "rubric");
  const combined    = combineBoards(fullFinal, rubricFinal);
  return { fullTask: fullFinal, rubric: rubricFinal, combined };
}

function rowsForBoard(tab, boards) {
  let rows;
  const scoreOf = (r) => tab === "combined" ? r.score : r.netScore;
  if (tab === "combined") {
    rows = [...boards.combined.values()];
    rows.sort((a, b) => (b.score - a.score) || a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }));
  } else {
    rows = [...boards[tab].values()];
    rows.sort((a, b) => (b.netScore - a.netScore) || a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }));
  }
  let lastScore = null;
  let lastRank = 0;
  rows.forEach((r, i) => {
    const score = scoreOf(r);
    r.rank = score === lastScore ? lastRank : i + 1;
    r.key = nameKey(r.displayName);
    lastScore = score;
    lastRank = r.rank;
  });
  for (const r of rows) {
    r.tieSize = rows.filter((other) => other.rank === r.rank).length;
  }
  return rows;
}

// -----------------------------------------------------------------------------
// Trend (movement since last visit) — stored in localStorage.
// -----------------------------------------------------------------------------

function loadTrendBaseline() {
  try { state.trendBaseline = JSON.parse(localStorage.getItem(LS_TREND) || "null"); }
  catch { state.trendBaseline = null; }
}

function saveTrendSnapshot(boards) {
  try {
    const ranks = { fullTask: {}, rubric: {} };
    rowsForBoard("fullTask", boards).forEach((r) => { ranks.fullTask[r.key] = r.rank; });
    rowsForBoard("rubric",   boards).forEach((r) => { ranks.rubric[r.key]   = r.rank; });
    localStorage.setItem(LS_TREND, JSON.stringify({ ranks, savedAt: Date.now() }));
  } catch { /* ignore quota / privacy mode */ }
}

function trendFor(tab, key, rank) {
  const prev = state.trendBaseline?.ranks?.[tab]?.[key];
  if (prev == null) return { dir: "new" };
  const delta = prev - rank; // positive = moved up
  if (delta > 0) return { dir: "up", n: delta };
  if (delta < 0) return { dir: "down", n: -delta };
  return { dir: "flat" };
}

function trendHtml(t) {
  if (t.dir === "up")   return `<span class="trend trend-up">▲ ${t.n}</span>`;
  if (t.dir === "down") return `<span class="trend trend-down">▼ ${t.n}</span>`;
  if (t.dir === "new")  return `<span class="trend trend-new">NEW</span>`;
  return `<span class="trend trend-flat">—</span>`;
}

// -----------------------------------------------------------------------------
// Render — top level.
// -----------------------------------------------------------------------------

function renderAll() {
  renderStatus();
  renderFetchState();
  renderWeekSelector();
  renderTabHeaders();
  renderHero();
  renderYou();
  renderBoard();
  if (state.admin.unlocked) renderAdminPanel();
}

function renderFetchState() {
  const banner = $("loading-banner");
  if (banner) {
    if (state.sheet.fetching) { banner.textContent = "Fetching claim sheet…"; banner.className = "banner banner-info"; banner.hidden = false; }
    else if (state.sheet.error) { banner.textContent = "Couldn't load the claim sheet — " + state.sheet.error; banner.className = "banner banner-error"; banner.hidden = false; }
    else banner.hidden = true;
  }
  const lu = $("last-updated");
  if (lu) lu.textContent = state.sheet.lastFetched ? "Updated " + state.sheet.lastFetched.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

function renderWeekSelector() {
  const sel = $("week-select");
  if (!sel) return;
  const opts = [`<option value="live">Current (live)</option>`];
  for (const a of state.archives) opts.push(`<option value="${escapeAttr(a.id)}">${escapeHtml(a.rangeLabel || a.id)}</option>`);
  const desired = state.ui.view;
  sel.innerHTML = opts.join("");
  sel.value = desired === "live" ? "live" : (state.archives.some((a) => a.id === desired) ? desired : "live");
  if (sel.value !== desired) state.ui.view = sel.value;
}

function renderTabHeaders() {
  const viewing = state.ui.view === "live" ? "" : " · archived";
  $("board-title").textContent = "Full leaderboard — Full Task" + viewing;
}

// -----------------------------------------------------------------------------
// Hero: live performance summary.
// -----------------------------------------------------------------------------

function renderHero() {
  $("hero").hidden = state.ui.view !== "live";
  if (state.ui.view !== "live") return;
  if (!state.sheet.base) {
    $("top-score").textContent = "--";
    $("performance-summary").textContent = "Loading current standings...";
    $("stat-completed").textContent = "--";
    $("stat-active").textContent = "--";
    $("stat-leader").textContent = "--";
    return;
  }
  const rows = rowsForBoard("fullTask", deriveFinalBoards());
  const leaderScore = rows[0]?.netScore || 0;
  const leaders = rows.filter((r) => r.rank === 1 && leaderScore > 0).map((r) => r.displayName);
  const totalCompleted = rows.reduce((sum, r) => sum + (r.completed || 0), 0);
  const active = rows.filter((r) => (r.completed || 0) > 0).length;
  $("top-score").textContent = leaderScore;
  $("performance-summary").textContent = leaders.length
    ? `${leaders.slice(0, 3).join(", ")} ${leaders.length > 3 ? "+" + (leaders.length - 3) + " more " : ""}${leaders.length === 1 ? "is" : "are"} setting the pace.`
    : "No completed tasks yet. First one on the board sets the pace.";
  $("stat-completed").textContent = totalCompleted;
  $("stat-active").textContent = active;
  $("stat-leader").textContent = leaderScore;
}

// -----------------------------------------------------------------------------
// "You" — name-picker identity + personalized pressure line.
// -----------------------------------------------------------------------------

function currentFullRows() {
  if (state.ui.view !== "live" || !state.sheet.base) return [];
  return rowsForBoard("fullTask", deriveFinalBoards());
}

function renderYou() {
  const youCard = $("you-card");
  const identify = $("identify-card");
  // "You" mechanics are tied to the live Full Task race.
  const eligible = state.ui.view === "live" && state.ui.tab === "fullTask" && !!state.sheet.base;
  if (!eligible) { youCard.hidden = true; identify.hidden = true; return; }

  const rows = currentFullRows();
  if (!state.me) {
    youCard.hidden = true;
    identify.hidden = rows.length === 0;
    return;
  }

  identify.hidden = true;
  youCard.hidden = false;
  const me = rows.find((r) => r.key === state.me);
  $("you-badge").textContent = initials(me ? me.displayName : state.me);
  if (!me) {
    $("you-name").textContent = "You";
    $("you-meta").textContent = "You're not on this week's Full Task board yet — claim a task to get on the board.";
    $("you-pressure").innerHTML = "";
    return;
  }

  $("you-name").textContent = me.displayName;
  $("you-meta").innerHTML = `Rank <strong>#${me.rank}</strong> &middot; <strong>${me.netScore}</strong> net &middot; ${me.redoCounter} redos`;

  const rank3 = rows.find((r) => r.rank === 3);
  let pressure = "";
  if (me.rank === 1) {
    const second = rows.find((r) => r.rank === 2);
    const lead = second ? me.netScore - second.netScore : me.netScore;
    pressure = `<span class="highlight">${me.tieSize > 1 ? "Tied #1" : "You're #1"}</span><br><span class="muted small">${lead > 0 ? lead + "-task lead" : "tied at the top — push"}</span>`;
  } else if (me.rank <= 3) {
    const below = rows.find((r) => r.rank === me.rank + 1);
    const cushion = below ? me.netScore - below.netScore : me.netScore;
    pressure = `<span class="highlight">Top 3 performer</span><br><span class="muted small">${me.tieSize > 1 ? "tied at rank #" + me.rank : (cushion > 0 ? cushion + "-task cushion" : "tied — keep pushing")}</span>`;
  } else if (rank3) {
    const need = Math.max(1, rank3.netScore - me.netScore + 1);
    pressure = `<span class="gap">${need} ${need === 1 ? "task" : "tasks"} from top 3</span><br><span class="muted small">Keep climbing the board</span>`;
  } else {
    pressure = `<span class="gap">Claim tasks to climb</span>`;
  }
  $("you-pressure").innerHTML = pressure;

  if (me.rank <= 3) maybeConfetti();
}

function openPicker() {
  const rows = currentFullRows();
  $("picker-search").value = "";
  renderPickerList(rows, "");
  openModal("picker-modal");
  setTimeout(() => $("picker-search").focus(), 60);
}

function renderPickerList(rows, filter) {
  const list = $("picker-list");
  const f = filter.trim().toLowerCase();
  const shown = rows.filter((r) => !f || r.displayName.toLowerCase().includes(f));
  if (!shown.length) { list.innerHTML = `<p class="picker-empty">No matching names on the board.</p>`; return; }
  list.innerHTML = shown.map((r) => `
    <button type="button" class="picker-item" data-pick="${escapeAttr(r.key)}">
      <span>${escapeHtml(r.displayName)}</span>
      <span class="pi-rank">#${r.rank} · ${r.netScore} net</span>
    </button>
  `).join("");
  list.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", () => chooseMe(btn.dataset.pick));
  });
}

function chooseMe(key) {
  state.me = key;
  localStorage.setItem(LS_ME, key);
  state.confettiFired = false;
  closeModal("picker-modal");
  renderYou();
  renderBoard();
  showToast("That's you — your row is highlighted in gold.", "success");
}

function clearMe() {
  state.me = null;
  localStorage.removeItem(LS_ME);
  renderYou();
  renderBoard();
}

// -----------------------------------------------------------------------------
// Board: podium (Full Task) + leaderboard table, or coming-soon / archive.
// -----------------------------------------------------------------------------

function renderBoard() {
  const podiumCard = $("podium-card");
  const tableWrap  = $("board-table-wrap");
  const overlayLegend = $("overlay-legend");

  tableWrap.hidden = false;

  // Podium only for live Full Task.
  const showPodium = state.ui.view === "live" && state.ui.tab === "fullTask";
  podiumCard.hidden = !showPodium;

  if (state.ui.view === "live") {
    const boards = deriveFinalBoards();
    const rows = rowsForBoard(state.ui.tab, boards);
    if (showPodium) renderPodium(rows);
    renderLeaderboardRows(rows);
    // Persist this visit's standings so next visit can show trends.
    if (state.sheet.base) saveTrendSnapshot(boards);
  } else {
    const archive = state.archiveCache[state.ui.view];
    if (!archive) {
      loadArchive(state.ui.view);
      $("leaderboard-tbody").innerHTML = `<tr><td colspan="5" class="muted center">Loading archive…</td></tr>`;
      return;
    }
    renderArchiveRows(archive.boards?.[state.ui.tab] || []);
  }
}

function renderPodium(rows) {
  const el = $("podium");
  const topPerformers = rows.filter((r) => r.rank <= 3 && r.netScore > 0);
  if (!topPerformers.length) { el.innerHTML = `<p class="podium-empty">No contributors on the board yet — be the first to claim a task.</p>`; return; }
  const medals = { 1: "🥇", 2: "🥈", 3: "🥉" };
  const classicPodium = topPerformers.length === 3 && new Set(topPerformers.map((r) => r.rank)).size === 3;
  // Render order: 2nd, 1st, 3rd for a classic podium feel when there are no ties.
  const order = classicPodium ? [topPerformers[1], topPerformers[0], topPerformers[2]] : topPerformers;
  el.innerHTML = order.map((r) => {
    const isYou = state.me && r.key === state.me;
    return `
      <div class="podium-slot podium-${r.rank}">
        <div class="podium-medal">${medals[r.rank] || ""}</div>
        <div class="podium-name">${escapeHtml(r.displayName)}</div>
        ${r.tieSize > 1 ? `<div class="podium-tie">Tied #${r.rank}</div>` : ""}
        <div class="podium-net"><b>${r.netScore}</b> net · ${r.redoCounter} redos</div>
        <div class="podium-stat">${r.completed} completed</div>
        ${isYou ? `<div class="podium-you-tag">You</div>` : ""}
      </div>
    `;
  }).join("");
}

function renderLeaderboardRows(rows) {
  const tbody = $("leaderboard-tbody");
  const overlayLegend = $("overlay-legend");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted center">No contributors yet.</td></tr>`;
    if (overlayLegend) overlayLegend.hidden = true;
    return;
  }
  let anyOverlay = false;
  const bestScore = Math.max(1, ...rows.map((r) => r.netScore || 0));
  tbody.innerHTML = rows.map((r) => {
    if (r.hasCompletedOverlay || r.hasRedoOverlay) anyOverlay = true;
    const ovScore = r.hasCompletedOverlay ? ' <span class="overlay-mark" title="Overlay applied">&bull;</span>' : "";
    const ovRedo  = r.hasRedoOverlay      ? ' <span class="overlay-mark" title="Overlay applied">&bull;</span>' : "";
    const isYou = state.me && r.key === state.me;
    const topRank = r.rank <= 3 && r.netScore > 0;
    const rankTag = r.tieSize > 1 && r.rank === 1 ? "Tied leader" : r.tieSize > 1 && topRank ? `Tied #${r.rank}` : r.rank === 1 && r.netScore > 0 ? "Leader" : topRank ? "Top performer" : `${Math.max(1, r.rank - 3)} from top 3`;
    const scorePct = Math.max(4, Math.round(((r.netScore || 0) / bestScore) * 100));
    const t = trendFor(state.ui.tab, r.key, r.rank);
    const cls = [`rank-${r.rank <= 3 ? r.rank : "n"}`, isYou ? "is-you" : "", topRank ? "top-rank" : ""].filter(Boolean).join(" ");
    return `
      <tr class="${cls}" style="--score-pct:${scorePct}%">
        <td class="col-rank"><span class="rank-badge">${r.rank}</span></td>
        <td class="col-name">
          <button class="name-link" data-history="${escapeAttr(r.displayName)}">${escapeHtml(r.displayName)}</button>${isYou ? '<span class="you-pill">You</span>' : ""}
          ${rankTag ? `<div class="rank-flavor">${escapeHtml(rankTag)}</div>` : ""}
        </td>
        <td class="col-trend">${trendHtml(t)}</td>
        <td class="col-count"><span class="score-num">${r.netScore}${ovScore}</span><span class="score-meter" aria-hidden="true"><span></span></span></td>
        <td class="col-redo">${r.redoCounter}${ovRedo}</td>
      </tr>
    `;
  }).join("");
  if (overlayLegend) overlayLegend.hidden = false;
  tbody.querySelectorAll("[data-history]").forEach((btn) => btn.addEventListener("click", () => openHistory(btn.dataset.history)));
}

function renderArchiveRows(archivedRows) {
  const tbody = $("leaderboard-tbody");
  $("overlay-legend").hidden = true;
  if (!archivedRows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted center">No contributors in this archive.</td></tr>`;
    return;
  }
  tbody.innerHTML = archivedRows.map((r) => `
    <tr class="rank-${r.rank <= 3 ? r.rank : "n"}">
      <td class="col-rank"><span class="rank-badge">${r.rank}</span></td>
      <td class="col-name"><button class="name-link" data-archived-name="${escapeAttr(r.name)}">${escapeHtml(r.name)}</button></td>
      <td class="col-trend"><span class="trend trend-flat">—</span></td>
      <td class="col-count">${r.netScore ?? r.score ?? 0}</td>
      <td class="col-redo">${r.redoCounter ?? r.totalRedos ?? 0}</td>
    </tr>
  `).join("");
  tbody.querySelectorAll("[data-archived-name]").forEach((btn) => btn.addEventListener("click", () => openArchiveHistory(btn.dataset.archivedName)));
}

// -----------------------------------------------------------------------------
// Confetti (top-3 celebration, once per session).
// -----------------------------------------------------------------------------

function maybeConfetti() {
  if (state.confettiFired) return;
  state.confettiFired = true;
  const colors = ["#f5c542", "#25d07d", "#ffffff", "#ffd95e"];
  for (let i = 0; i < 80; i++) {
    const p = document.createElement("div");
    p.className = "confetti-piece";
    p.style.left = Math.random() * 100 + "vw";
    p.style.background = colors[i % colors.length];
    const dur = 2.5 + Math.random() * 2;
    p.style.transition = `transform ${dur}s linear, opacity ${dur}s linear`;
    document.body.appendChild(p);
    requestAnimationFrame(() => {
      p.style.transform = `translateY(105vh) rotate(${Math.random() * 720}deg)`;
      p.style.opacity = "0";
    });
    setTimeout(() => p.remove(), dur * 1000 + 100);
  }
}

// -----------------------------------------------------------------------------
// History modal — live and archived flavours.
// -----------------------------------------------------------------------------

function openHistory(displayName) {
  const k = nameKey(displayName);
  const boards = deriveFinalBoards();
  const f = boards.fullTask.get(k);
  const ovInfo = state.overlays[k] || null;
  const adjustments = ovInfo?.adjustments || [];

  const sectionFor = (label, stats, isFull) => {
    if (!stats) return "";
    const ovStar = (b) => b ? ' <span class="overlay-mark" title="Overlay applied">&bull;</span>' : "";
    const sampleRows = (stats.rows || []).slice(0, 12);
    return `
      <div class="history-section">
        <div class="history-section-head">
          <span>${escapeHtml(label)}</span>
          <span class="total">Net ${stats.netScore} · Redos ${stats.redoCounter}</span>
        </div>
        <table>
          <thead><tr><th>Field</th><th>Live</th><th>After overlay</th></tr></thead>
          <tbody>
            <tr><td>Completed</td><td>${stats.baseCompleted}</td><td>${stats.completed}${ovStar(stats.hasCompletedOverlay)}</td></tr>
            <tr><td>Outstanding redos</td><td>${stats.outstandingRedo}</td><td>${stats.outstandingRedo}</td></tr>
            <tr><td>Net score</td><td>${Math.max(0, stats.baseCompleted - stats.outstandingRedo)}</td><td>${stats.netScore}</td></tr>
            <tr><td>Redo counter</td><td>${stats.baseRedoCounter}</td><td>${stats.redoCounter}${ovStar(stats.hasRedoOverlay)}</td></tr>
          </tbody>
        </table>
        ${sampleRows.length ? `
          <table>
            <thead><tr><th>Task</th><th>Date</th><th>Done</th><th>Redo</th><th>Re-Do done</th>${isFull ? "<th>2nd redo done</th>" : ""}</tr></thead>
            <tbody>
              ${sampleRows.map((row) => `
                <tr>
                  <td>${escapeHtml(row.taskId || "—")}</td>
                  <td>${escapeHtml(row.date || "—")}</td>
                  <td>${row.done ? "✓" : "·"}</td>
                  <td>${row.isRedo ? "REDO" : ""}</td>
                  <td>${row.redoDone ? "✓" : (row.isRedo ? "·" : "")}</td>
                  ${isFull ? `<td>${row.secondRedoDone ? "✓" : ""}</td>` : ""}
                </tr>
              `).join("")}
            </tbody>
          </table>
          ${stats.rows.length > sampleRows.length ? `<p class="muted small" style="margin:6px 12px">…and ${stats.rows.length - sampleRows.length} more rows.</p>` : ""}
        ` : ""}
      </div>
    `;
  };

  const adjHtml = adjustments.length ? `
    <div class="history-section">
      <div class="history-section-head"><span>Admin adjustments</span><span class="total muted">${adjustments.length}</span></div>
      <ul class="adj-list" style="margin:8px 12px">
        ${adjustments.slice().reverse().map((a) => `
          <li>${escapeHtml(a.board)}.${escapeHtml(a.field)}:
            ${escapeHtml(String(a.from ?? "—"))} → ${escapeHtml(String(a.to ?? "—"))}
            <span class="muted">by ${escapeHtml(a.by || "—")}${a.at?.seconds ? " on " + new Date(a.at.seconds * 1000).toLocaleString() : ""}</span>
          </li>
        `).join("")}
      </ul>
    </div>
  ` : "";

  const body = sectionFor("Full Task", f, true) + adjHtml;
  $("history-name").textContent = displayName;
  $("history-body").innerHTML = body || `<p class="muted">No data for this person.</p>`;
  openModal("history-modal");
}

function openArchiveHistory(name) {
  const archive = state.archiveCache[state.ui.view];
  if (!archive) return;
  const ph = (archive.perPersonHistory || {})[nameKey(name)];
  const html = ph
    ? `<p class="muted small">From archived snapshot — read only.</p><pre class="log">${escapeHtml(JSON.stringify(ph, null, 2))}</pre>`
    : `<p class="muted">No detailed history stored for this person in this archive.</p>`;
  $("history-name").textContent = name;
  $("history-body").innerHTML = html;
  openModal("history-modal");
}

// -----------------------------------------------------------------------------
// Listeners — Firestore real-time subscriptions.
// -----------------------------------------------------------------------------

function startListeners() {
  if (state.fb.status === "error" || !state.fb.db) return;
  const db = state.fb.db;

  onSnapshot(doc(db, "meta", "site"), (snap) => {
    if (!snap.exists()) return;
    const m = snap.data();
    const sheetChanged = state.meta?.currentSheetId !== m.currentSheetId;
    state.meta = m;
    const sheetIdEl = $("current-sheet-id");
    if (sheetIdEl) sheetIdEl.textContent = m.currentSheetId || "—";
    if (sheetChanged && m.currentSheetId) loadSheet(m.currentSheetId);
  }, (err) => console.error("[meta listener]", err));

  onSnapshot(collection(db, "overlays"), (snap) => {
    const next = {}; snap.forEach((d) => { next[d.id] = d.data(); });
    state.overlays = next; renderAll();
  }, (err) => console.error("[overlays listener]", err));

  onSnapshot(collection(db, "aliases"), (snap) => {
    const next = {}; snap.forEach((d) => { next[d.id] = d.data(); });
    state.aliases = next; rescore(); renderAll();
  }, (err) => console.error("[aliases listener]", err));

  onSnapshot(collection(db, "archives"), (snap) => {
    const arr = []; snap.forEach((d) => { arr.push({ id: d.id, ...d.data() }); });
    arr.sort((a, b) => (b.archivedAt?.seconds || 0) - (a.archivedAt?.seconds || 0));
    state.archives = arr; renderWeekSelector();
  }, (err) => console.error("[archives listener]", err));
}

async function loadArchive(weekLabel) {
  if (state.archiveCache[weekLabel]) return state.archiveCache[weekLabel];
  if (!state.fb.db) return null;
  try {
    const snap = await getDoc(doc(state.fb.db, "archives", weekLabel));
    if (snap.exists()) { state.archiveCache[weekLabel] = snap.data(); renderBoard(); return state.archiveCache[weekLabel]; }
  } catch (err) {
    console.error("[archive load]", err);
    showToast("Couldn't load that archive.", "error");
  }
  return null;
}

// -----------------------------------------------------------------------------
// Event wiring.
// -----------------------------------------------------------------------------

function attachEvents() {
  $("week-select").addEventListener("change", (e) => {
    state.ui.view = e.target.value;
    renderTabHeaders(); renderHero(); renderYou(); renderBoard();
  });
  $("refresh-btn").addEventListener("click", () => loadSheet(state.meta?.currentSheetId || DEFAULT_SHEET_ID));

  // "You" identity
  $("identify-btn").addEventListener("click", openPicker);
  $("you-change").addEventListener("click", () => { clearMe(); openPicker(); });
  $("picker-search").addEventListener("input", (e) => renderPickerList(currentFullRows(), e.target.value));

  // Admin
  $("admin-link").addEventListener("click", openAdminGate);
  $("change-admin-name").addEventListener("click", changeAdminName);
  $("password-form").addEventListener("submit", onPasswordSubmit);
  $("add-person-form").addEventListener("submit", onAddPersonSubmit);
  $("alias-form").addEventListener("submit", onAliasSubmit);
  $("overlay-edit-form").addEventListener("submit", onOverlayEditSubmit);
  $("overlay-clear-all").addEventListener("click", onOverlayClearAll);
  $("swap-week-btn").addEventListener("click", () => {
    $("swap-error").hidden = true;
    $("swap-url").value = "";
    $("swap-label").value = guessRangeLabel();
    openModal("swap-modal");
  });
  $("swap-form").addEventListener("submit", onSwapSubmit);
}

// -----------------------------------------------------------------------------
// Admin: gate + name.
// -----------------------------------------------------------------------------

function openAdminGate() {
  if (state.fb.status === "error") { showToast("Firebase not connected — admin unavailable.", "error"); return; }
  if (state.admin.unlocked) { openAdmin(); return; }
  $("password-error").hidden = true;
  $("password-input").value = "";
  openModal("password-modal");
  setTimeout(() => $("password-input").focus(), 60);
}

function onPasswordSubmit(ev) {
  ev.preventDefault();
  if ($("password-input").value === ADMIN_PASSWORD) {
    state.admin.unlocked = true;
    closeModal("password-modal");
    openAdmin();
  } else $("password-error").hidden = false;
}

function openAdmin() { ensureAdminName(); renderAdminPanel(); openModal("admin-modal"); }

function ensureAdminName() {
  if (!state.admin.name) {
    const v = prompt("Enter your name (used to attribute adjustments):", "");
    state.admin.name = (v && v.trim()) || "Admin";
    sessionStorage.setItem("tsip_admin_name", state.admin.name);
  }
  $("admin-name-display").textContent = state.admin.name;
}

function changeAdminName() {
  const v = prompt("Your name:", state.admin.name || "");
  if (v && v.trim()) {
    state.admin.name = v.trim();
    sessionStorage.setItem("tsip_admin_name", state.admin.name);
    $("admin-name-display").textContent = state.admin.name;
  }
}

// -----------------------------------------------------------------------------
// Admin panel rendering.
// -----------------------------------------------------------------------------

function renderAdminPanel() {
  $("current-sheet-id").textContent = state.meta?.currentSheetId || "—";
  renderOverridesTable();
  renderAliasesTable();
}

function renderOverridesTable() {
  const tbody = $("overrides-tbody");
  if (!tbody) return;
  const boards = deriveFinalBoards();
  const keys = new Set([...boards.fullTask.keys(), ...boards.rubric.keys()]);
  const rows = [...keys].map((k) => {
    const f = boards.fullTask.get(k), r = boards.rubric.get(k);
    return {
      key: k, displayName: f?.displayName || r?.displayName || k,
      ftNet: f?.netScore ?? 0, ftRedo: f?.redoCounter ?? 0,
      anyOverlay: !!state.overlays[k],
    };
  });
  rows.sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }));
  tbody.innerHTML = rows.length ? rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.displayName)}${r.anyOverlay ? ' <span class="overlay-mark">&bull;</span>' : ''}</td>
      <td>${r.ftNet}</td><td>${r.ftRedo}</td>
      <td class="row-actions"><button class="btn btn-secondary" data-edit-overlay="${escapeAttr(r.key)}">Edit overlay</button></td>
    </tr>
  `).join("") : `<tr><td colspan="4" class="muted center">No contributors yet — fetch the sheet first.</td></tr>`;
  tbody.querySelectorAll("[data-edit-overlay]").forEach((btn) => btn.addEventListener("click", () => openOverlayEditor(btn.dataset.editOverlay)));
}

function renderAliasesTable() {
  const tbody = $("aliases-tbody");
  if (!tbody) return;
  const entries = Object.entries(state.aliases);
  if (!entries.length) { tbody.innerHTML = `<tr><td colspan="3" class="muted center">No aliases yet.</td></tr>`; return; }
  tbody.innerHTML = entries.map(([k, v]) => `
    <tr>
      <td>${escapeHtml(k)}</td><td>${escapeHtml(v.canonical || "—")}</td>
      <td class="row-actions"><button class="btn btn-danger" data-del-alias="${escapeAttr(k)}">Delete</button></td>
    </tr>
  `).join("");
  tbody.querySelectorAll("[data-del-alias]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(`Delete alias "${btn.dataset.delAlias}"?`)) return;
      try { await deleteDoc(doc(state.fb.db, "aliases", btn.dataset.delAlias)); showToast("Alias removed.", "success"); }
      catch (err) { showToast("Couldn't delete alias: " + err.message, "error"); }
    });
  });
}

// -----------------------------------------------------------------------------
// Admin: add overlay-only person.
// -----------------------------------------------------------------------------

async function onAddPersonSubmit(ev) {
  ev.preventDefault();
  const errEl = $("add-person-error");
  errEl.hidden = true;
  try {
    const name = normalizeNameRaw($("add-person-name").value);
    if (!name) throw new Error("Name is required.");
    const ftC = readNumOrNull("add-person-ft-completed");
    const ftR = readNumOrNull("add-person-ft-redo");
    const k = nameKey(name);
    const adjustments = [];
    const now = Date.now();
    const adj = (board, field, to) => adjustments.push({ board, field, from: null, to, by: state.admin.name || "Admin", at: { seconds: Math.floor(now/1000) } });
    if (ftC !== null) adj("fullTask", "completed", ftC);
    if (ftR !== null) adj("fullTask", "redoCounter", ftR);
    const payload = {
      displayName: name, addedByOverlayOnly: true,
      fullTask: { ...(ftC !== null ? { completed: ftC } : {}), ...(ftR !== null ? { redoCounter: ftR } : {}) },
      adjustments, updatedAt: serverTimestamp(),
    };
    await setDoc(doc(state.fb.db, "overlays", k), payload, { merge: true });
    showToast(`Added overlay-only person: ${name}`, "success");
    ["add-person-name","add-person-ft-completed","add-person-ft-redo"].forEach((id) => $(id).value = "");
  } catch (err) { console.error(err); errEl.textContent = err.message; errEl.hidden = false; }
}

function readNumOrNull(id) {
  const v = $(id).value.trim();
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid number in field: ${id}`);
  return Math.floor(n);
}

// -----------------------------------------------------------------------------
// Admin: aliases.
// -----------------------------------------------------------------------------

async function onAliasSubmit(ev) {
  ev.preventDefault();
  const errEl = $("alias-error");
  errEl.hidden = true;
  try {
    const from = normalizeNameRaw($("alias-from").value);
    const to   = normalizeNameRaw($("alias-to").value);
    if (!from || !to) throw new Error("Both fields are required.");
    await setDoc(doc(state.fb.db, "aliases", from.toLowerCase()), { canonical: to, by: state.admin.name || "Admin", at: serverTimestamp() });
    showToast(`Alias saved: ${from} → ${to}`, "success");
    $("alias-from").value = ""; $("alias-to").value = "";
  } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
}

// -----------------------------------------------------------------------------
// Admin: overlay editor.
// -----------------------------------------------------------------------------

function openOverlayEditor(personKey) {
  const boards = deriveFinalBoards();
  const f = boards.fullTask.get(personKey);
  const displayName = state.overlays[personKey]?.displayName || f?.displayName || personKey;
  $("overlay-edit-title").textContent = "Edit overlay — " + displayName;
  $("overlay-edit-key").value = personKey;
  $("overlay-edit-error").hidden = true;
  const setField = (id, ovValue, liveValue) => { const el = $(id); el.value = (ovValue != null) ? ovValue : ""; el.placeholder = "Live: " + liveValue; };
  const ov = state.overlays[personKey] || {};
  setField("ovl-ft-completed", ov.fullTask?.completed,   f?.baseCompleted   ?? 0);
  setField("ovl-ft-redo",      ov.fullTask?.redoCounter, f?.baseRedoCounter ?? 0);
  openModal("overlay-edit-modal");
}

async function onOverlayEditSubmit(ev) {
  ev.preventDefault();
  const errEl = $("overlay-edit-error");
  errEl.hidden = true;
  try {
    const k = $("overlay-edit-key").value;
    if (!k) throw new Error("No person key.");
    const ftC = readBlankOrNum("ovl-ft-completed");
    const ftR = readBlankOrNum("ovl-ft-redo");
    const existing = state.overlays[k] || { adjustments: [] };
    const boards = deriveFinalBoards();
    const f = boards.fullTask.get(k);
    const adj = (existing.adjustments || []).slice();
    const now = { seconds: Math.floor(Date.now() / 1000) };
    const logChange = (board, field, fromLive, fromOverlay, to) => {
      const before = (fromOverlay != null) ? fromOverlay : fromLive;
      if (before === to) return;
      adj.push({ board, field, from: before, to, by: state.admin.name || "Admin", at: now });
    };
    logChange("fullTask", "completed",   f?.baseCompleted   ?? 0, existing.fullTask?.completed,   ftC);
    logChange("fullTask", "redoCounter", f?.baseRedoCounter ?? 0, existing.fullTask?.redoCounter, ftR);
    const displayName = existing.displayName || f?.displayName || k;
    const docPayload = {
      displayName, addedByOverlayOnly: !!existing.addedByOverlayOnly,
      fullTask: { ...(ftC !== null ? { completed: ftC } : {}), ...(ftR !== null ? { redoCounter: ftR } : {}) },
      adjustments: adj, updatedAt: serverTimestamp(),
    };
    const hasAny = ftC !== null || ftR !== null;
    if (!hasAny && !existing.addedByOverlayOnly) {
      await deleteDoc(doc(state.fb.db, "overlays", k));
      showToast("Overlays cleared.", "success");
    } else {
      await setDoc(doc(state.fb.db, "overlays", k), docPayload);
      showToast("Overlay saved.", "success");
    }
    closeModal("overlay-edit-modal");
  } catch (err) { console.error(err); errEl.textContent = err.message; errEl.hidden = false; }
}

function readBlankOrNum(id) {
  const v = $(id).value.trim();
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error("Numbers must be ≥ 0.");
  return Math.floor(n);
}

async function onOverlayClearAll() {
  const k = $("overlay-edit-key").value;
  if (!k) return;
  if (!confirm("Remove all overlays for this person? Everything reverts to live values.")) return;
  try { await deleteDoc(doc(state.fb.db, "overlays", k)); showToast("Overlays removed.", "success"); closeModal("overlay-edit-modal"); }
  catch (err) { showToast("Couldn't remove overlay: " + err.message, "error"); }
}

// -----------------------------------------------------------------------------
// Admin: start new week / swap sheet.
// -----------------------------------------------------------------------------

function extractSheetId(input) {
  if (!input) return null;
  const s = input.trim();
  const m = s.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
  return null;
}

function guessRangeLabel() {
  if (!state.sheet.raw) return "";
  const all = [];
  const collect = (rows, cfg, headers) => {
    const dateDone = resolveColumn(headers, cfg.dateDone);
    for (const row of rows) {
      const d = normalizeDate(cell(row, dateDone));
      if (d) all.push(d);
    }
  };
  collect(state.sheet.raw.fullRows, FULL, state.sheet.raw.fullHeaders);
  collect(state.sheet.raw.rubricRows, RUBRIC, state.sheet.raw.rubricHeaders);
  if (!all.length) return "";
  all.sort();
  const fmt = (iso) => { const [, m, d] = iso.split("-").map(Number); return `${m}/${d}`; };
  return all[0] === all[all.length - 1] ? fmt(all[0]) : `${fmt(all[0])} – ${fmt(all[all.length - 1])}`;
}

function isoDateRangeForLabel() {
  if (!state.sheet.raw) return null;
  const all = [];
  const fullDateDone = resolveColumn(state.sheet.raw.fullHeaders, FULL.dateDone);
  const rubricDateDone = resolveColumn(state.sheet.raw.rubricHeaders, RUBRIC.dateDone);
  for (const row of state.sheet.raw.fullRows)   { const d = normalizeDate(cell(row, fullDateDone));   if (d) all.push(d); }
  for (const row of state.sheet.raw.rubricRows) { const d = normalizeDate(cell(row, rubricDateDone)); if (d) all.push(d); }
  if (!all.length) return null;
  all.sort();
  return { min: all[0], max: all[all.length - 1] };
}

async function onSwapSubmit(ev) {
  ev.preventDefault();
  const errEl = $("swap-error");
  errEl.hidden = true;
  const btn = $("swap-confirm");
  btn.disabled = true;
  try {
    const newId = extractSheetId($("swap-url").value);
    if (!newId) throw new Error("Couldn't find a sheet ID in that URL.");
    const label = ($("swap-label").value || "").trim();
    if (!label) throw new Error("Label is required.");

    const boards = deriveFinalBoards();
    const mapBoard = (tab) => rowsForBoard(tab, boards).map((r) => ({
      rank: r.rank, name: r.displayName, completed: r.completed,
      outstandingRedo: r.outstandingRedo, redoCounter: r.redoCounter, netScore: r.netScore,
    }));
    const ftRows = mapBoard("fullTask");
    const rbRows = mapBoard("rubric");
    const cmRows = rowsForBoard("combined", boards).map((r) => ({
      rank: r.rank, name: r.displayName, fullTaskNet: r.fullTaskNet,
      rubricNet: r.rubricNet, totalRedos: r.totalRedos, score: r.score,
    }));

    const perPersonHistory = {};
    for (const [k, f] of boards.fullTask) {
      const r = boards.rubric.get(k);
      perPersonHistory[k] = { displayName: f.displayName || r?.displayName || k, fullTask: snapshotPerson(f), rubric: r ? snapshotPerson(r) : null, adjustments: (state.overlays[k]?.adjustments) || [] };
    }
    for (const [k, r] of boards.rubric) {
      if (perPersonHistory[k]) continue;
      perPersonHistory[k] = { displayName: r.displayName, fullTask: null, rubric: snapshotPerson(r), adjustments: (state.overlays[k]?.adjustments) || [] };
    }

    const range = isoDateRangeForLabel();
    const docId = range ? `${range.min}_to_${range.max}` : `week_${Date.now()}`;
    const archive = {
      weekLabel: docId, rangeLabel: label,
      sourceSheetId: state.meta?.currentSheetId || state.sheet.id || "",
      archivedBy: state.admin.name || "Admin", archivedAt: serverTimestamp(),
      boards: { fullTask: ftRows, rubric: rbRows, combined: cmRows },
      perPersonHistory,
    };
    await setDoc(doc(state.fb.db, "archives", docId), archive);

    const overlaySnap = await getDocs(collection(state.fb.db, "overlays"));
    for (const d of overlaySnap.docs) await deleteDoc(doc(state.fb.db, "overlays", d.id));

    await setDoc(doc(state.fb.db, "meta", "site"), { currentSheetId: newId, schemaVersion: 1, updatedAt: serverTimestamp() }, { merge: true });

    showToast(`Archived "${label}" — now reading from new sheet.`, "success");
    closeModal("swap-modal"); closeModal("admin-modal");
  } catch (err) { console.error(err); errEl.textContent = err.message; errEl.hidden = false; }
  finally { btn.disabled = false; }
}

function snapshotPerson(stats) {
  if (!stats) return null;
  return {
    baseCompleted: stats.baseCompleted, baseRedoCounter: stats.baseRedoCounter,
    completed: stats.completed, redoCounter: stats.redoCounter,
    outstandingRedo: stats.outstandingRedo, netScore: stats.netScore,
    hasCompletedOverlay: stats.hasCompletedOverlay, hasRedoOverlay: stats.hasRedoOverlay,
    rows: (stats.rows || []).map((r) => ({ taskId: r.taskId, date: r.date, done: r.done, isRedo: r.isRedo, redoDone: r.redoDone, secondRedoDone: r.secondRedoDone })),
  };
}

// -----------------------------------------------------------------------------
// Boot.
// -----------------------------------------------------------------------------

async function boot() {
  loadTrendBaseline();
  initFirebase();
  attachEvents();
  renderStatus();
  renderHero();
  await probeFirebase();
  if (state.fb.status === "connected") startListeners();
  await loadSheet(state.meta?.currentSheetId || DEFAULT_SHEET_ID);
}

boot();
