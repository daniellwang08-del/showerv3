import * as api from "./api.js";
import * as store from "./store.js";
import { resolveEngine, autofillPermissionOrigins } from "./engines.js";
import * as tabMsg from "./tab-messaging.js";

const root = document.getElementById("app");

const STYLES = [
  ["standard", "Standard"],
  ["concise", "Concise"],
  ["detailed", "Detailed"],
];
const FIELD_TYPES = [
  ["", "Auto"],
  ["short_text", "Short text"],
  ["textarea", "Paragraph"],
  ["yes_no", "Yes/No + why"],
  ["number", "Number / years"],
  ["cover_letter", "Cover letter"],
];

let state = {
  view: "loading",
  user: null,
  cache: null,
  sync: null, // { changed: string[] }
  sessions: [],
  queue: [], // all jobs (dashboard view=all)
  readyQueue: [], // ready to apply (resume DOCX completed)
  bestQueue: [], // strong matches (score >= 75)
  remoteQueue: [], // remote-only jobs
  mineQueue: [], // jobs posted by me
  todayQueue: [], // jobs added today (matches dashboard view=today)
  todayPlatformQueue: [], // today's scraped/platform jobs (not user-submitted)
  todayMineQueue: [], // today's user-submitted jobs
  todayCounts: { all: 0, platform: 0, mine: 0 },
  // Authoritative server totals (same as dashboard view switcher badges).
  dashboardCounts: { all: 0, today: 0, mine: 0, suggested: 0, applied_today: 0 },
  // Platform dashboard tile totals (from /scraper/stats + dashboard counts).
  platformCounts: {
    total: 0,
    ready: 0,
    best: 0,
    today: 0,
    remote: 0,
    mine: 0,
  },
  weeklyProgress: null, // { series, totals, min_match_score } from /jobs/dashboard/weekly-progress
  statsPeriod: "week", // "day" | "week" | "month"
  statsProgress: null, // period-scoped series for Statistics page
  statsLoading: false,
  scraperStats: null, // from /scraper/stats
  appliedQueue: [], // jobs applied to today (most recent first)
  // Which Jobs list the user opened chat from — Complete & Next advances in this list.
  applyListContext: null, // { key, view?, remote_only?, min_match_score?, jobIds: string[] }
  homeTab: "hub", // hub | progress | today | all | ready | best | remote | mine | tailor | stats | settings
  todaySubTab: "all", // "all" | "platform" | "mine" — narrows the New today list
  tailorSubTab: "making", // "making" | "ready" — in-progress vs generated resumes
  tailorHits: [], // unified resume search hits (library + job builds)
  tailorHitsLoading: false,
  tailorRuns: [], // [{ id, kind, jobId?, title, company, stage, label, status, error?, resumeId? }]
  pageByTab: {
    progress: 1,
    today: 1,
    all: 1,
    ready: 1,
    best: 1,
    remote: 1,
    mine: 1,
    tailor: 1,
  }, // 1-based page per list section
  BEST_MATCH_SCORE: 75,
  pageSize: 25, // rows per page, user-selectable
  listFilters: {
    title: "",
    company: "",
    workMode: "", // "" | remote | hybrid | onsite
    source: "", // "" | greenhouse | workday | ...  (or tailored|job_workflow on Tailor)
    sort: "created_at", // match_score | posted_date | created_at | source | title | company
    order: "desc",
  },
  queueLoading: false, // true while the Home job lists are being fetched
  pumbleConfigured: false,
  pumbleDestinationCount: 0,
  postingToPumble: false,
  modal: null, // { title, message, confirmLabel, tone, onConfirm, busy }
  minScore: store.DEFAULT_MIN_SCORE,
  autoAdvance: true, // Workday: fill + advance each step until Review (user submits)
  resumeSource: store.DEFAULT_RESUME_SOURCE, // "tailored" | "original"
  answerStrategy: "", // optional free-text for autofill LLM
  askHotkey: store.DEFAULT_ASK_HOTKEY, // page selection → assistant chat
  askHotkeyRecording: false,
  job: null, // { job_id, url, title, company, score, snapshot, messages, ready }
  jdOpen: true, // Job description <details>; collapses when chat starts
  style: "standard",
  fieldType: "",
  streaming: false,
  abort: null,
  toast: null,
  reportNotice: null, // { reportedTitle, reportedCompany } - shown above chat after reporting
  error: null,
  loginLoading: false,
  autofill: emptyAutofill(),
};

// Login form draft (kept outside render state so typing does not re-render on each key).
let loginDraft = { email: "", password: "", remember: false, showPassword: false };
// Tailor page JD paste (same reason — avoid remounting the textarea every keystroke).
let tailorJdDraft = "";

function emptyAutofill() {
  return {
    active: false,
    picking: false,
    discovering: false, // auto-discovery: scanning the page for the form container
    tabId: null,
    engine: null, // resolved engine descriptor for this run (platform-routed)
    fields: [],
    specs: [],
    statuses: {},
    needsUser: [],
    running: false,
    runStatus: null, // human-readable phase shown while a non-Workday fill runs
    error: null,
    reports: [], // Workday: per-step { step, filled[], missed[] }
    done: false, // Workday: run finished
    autoLoop: false, // Workday: auto-advance loop is driving this run
    loopStatus: null, // human-readable current loop action
    loopStop: false, // user requested the loop to stop
    loopFinished: null, // "review" | "stuck" | "needs_user" | "error" | null
    loopMessage: null, // human-readable outcome shown when the loop ends
    primaryFrameId: null, // content-script frame that owns the application form (embedded ATS)
  };
}

// Jobs can be massive, so every Home list is paginated client-side.
const JOBS_PAGE_SIZES = [25, 50, 100];

/** Snapshot scroll offsets before a full DOM rebuild (`.screen` is the main scroller). */
function captureScrollPositions() {
  const positions = {};
  const screen = root.querySelector(".screen");
  if (screen) positions.screen = screen.scrollTop;
  root.querySelectorAll("[data-scroll-preserve]").forEach((node) => {
    const key = node.getAttribute("data-scroll-preserve");
    if (key) positions[key] = node.scrollTop;
  });
  return positions;
}

function restoreScrollPositions(positions) {
  if (!positions) return;
  const apply = () => {
    const screen = root.querySelector(".screen");
    if (screen && positions.screen != null) screen.scrollTop = positions.screen;
    root.querySelectorAll("[data-scroll-preserve]").forEach((node) => {
      const key = node.getAttribute("data-scroll-preserve");
      if (!key || positions[key] == null) return;
      // Streaming chat sticks to the bottom; don't fight that.
      if (key === "messages" && state.streaming) return;
      node.scrollTop = positions[key];
    });
  };
  apply();
  // Layout can settle a frame later after replacing the tree; re-apply once.
  requestAnimationFrame(apply);
}

/**
 * @param {object} patch
 * @param {{ resetScroll?: boolean }} [opts]
 *   resetScroll — jump to top (view / section / page changes). Soft data refreshes
 *   preserve scroll so the 6s home poll and toast-adjacent updates don't yank the list.
 */
function setState(patch, opts = {}) {
  const beforeView = state.view;
  const beforeTab = state.homeTab;
  const beforePage = (state.pageByTab && state.pageByTab[state.homeTab]) || 1;
  const snap = opts.resetScroll ? null : captureScrollPositions();

  state = { ...state, ...patch };

  const navigated = state.view !== beforeView || state.homeTab !== beforeTab;
  const pageNow = (state.pageByTab && state.pageByTab[state.homeTab]) || 1;
  const pageChanged = !navigated && pageNow !== beforePage;

  render();

  if (opts.resetScroll || navigated || pageChanged) {
    requestAnimationFrame(() => {
      const screen = root.querySelector(".screen");
      if (screen) screen.scrollTop = 0;
    });
  } else if (snap) {
    restoreScrollPositions(snap);
  }
}

function setAutofill(patch) {
  setState({ autofill: { ...state.autofill, ...patch } });
}

// Collects per-frame AF_FIELDS responses during an extraction run.
let extractCollector = null;
// Resolves when the content script reports it finished a write pass.
let writeWaiter = null;
// Monotonic id correlating each AF_WRITE with its AF_WRITE_RESULT.
let writePassSeq = 0;
// Resolves the auto-advance loop's per-step wait when the page reports WD_DONE.
let wdStepWaiter = null;
// Monotonic seq for Workday WD_RUN / WD_ABORT so Stop invalidates in-flight work
// (including a WD_RUN already queued when Stop was clicked).
let wdRunSeq = 0;

// Messages from the injected picker/writer content script arrive here.
function scoreAutofillField(field) {
  let score = (field.controlCount || 0) * 10;
  const url = (field.frameUrl || "").toLowerCase();
  if (/greenhouse\.io/.test(url) && /embed\/job_app/.test(url)) score += 1000;
  else if (/greenhouse\.io/.test(url) && /\/jobs\//.test(url)) score += 900;
  else if (/greenhouse\.io/.test(url)) score += 500;
  if ((field.controlCount || 0) > 0) score += 50;
  return score;
}

// Debounce multi-frame / double-delivery of the ask-selection hotkey.
let lastAskSelectionAt = 0;

function onContentMessage(msg, sender) {
  if (!msg || !msg.type) return;
  if (msg.type === "ASK_SELECTION") {
    void handleAskSelectionMessage(msg);
    return;
  }
  if (msg.type === "APP_SUBMITTED") {
    void handleApplicationSubmitted(msg);
    return;
  }
  if (msg.type === "WEBAPP_OPEN_PENDING_JOB" && msg.jobId) {
    // Panel is already open: the dashboard just handed us a job to apply to.
    if (state.user) {
      chrome.storage.session.remove("pendingWebappJob").catch(() => {});
      openJob(String(msg.jobId), { redirect: false });
    }
    return;
  }
  if (msg.type === "AF_FIELDS") {
    if (!extractCollector) return;
    for (const f of msg.fields || []) extractCollector.collected.set(f.handle, f);
    let all = true;
    for (const h of extractCollector.expected) {
      if (!extractCollector.collected.has(h)) {
        all = false;
        break;
      }
    }
    if (all) extractCollector.finish();
    return;
  }
  if (!state.autofill.active) return;
  if (msg.type === "AF_FIELD_ADDED") {
    const frameId = sender && sender.frameId != null ? sender.frameId : 0;
    const field = {
      handle: msg.handle,
      label: msg.label || "(field)",
      level: msg.level || "valid",
      controlCount: msg.controlCount || 1,
      frameId,
      frameUrl: msg.frameUrl || (sender && sender.url) || "",
    };
    field._score = scoreAutofillField(field);
    const autoMode =
      state.autofill.discovering || !!(state.autofill.engine && state.autofill.engine.autoDiscover);
    if (autoMode) {
      const cur = state.autofill.fields[0];
      const curScore = cur && cur._score != null ? cur._score : -1;
      if (!cur || field._score >= curScore) {
        setAutofill({ fields: [field], primaryFrameId: frameId });
      }
      return;
    }
    const idx = state.autofill.fields.findIndex((f) => f.handle === msg.handle);
    if (idx >= 0) {
      const fields = state.autofill.fields.slice();
      fields[idx] = { ...fields[idx], ...field };
      setAutofill({ fields, primaryFrameId: frameId });
      return;
    }
    setAutofill({
      fields: [...state.autofill.fields, field],
      primaryFrameId: state.autofill.primaryFrameId != null ? state.autofill.primaryFrameId : frameId,
    });
  } else if (msg.type === "AF_WRITE_RESULT") {
    const statuses = { ...state.autofill.statuses };
    for (const r of msg.report || []) statuses[r.cid] = r.status;
    setAutofill({ statuses });
    if (writeWaiter && (msg.passId == null || msg.passId === writeWaiter.passId)) writeWaiter.finish();
  } else if (msg.type === "AF_AUTOSELECT_DONE") {
    // A frame finished auto-discovery. AF_FIELD_ADDED (if any) was delivered
    // before this from the same frame, so the container is already registered.
    if (state.autofill.discovering && msg.count) maybeAutoRun();
  } else if (msg.type === "AF_PICKING_STOPPED") {
    if (state.autofill.picking) setAutofill({ picking: false });
  } else if (msg.type === "WD_PROGRESS") {
    if (!state.autofill.active) return;
    if (msg.report) setAutofill({ reports: [...state.autofill.reports, msg.report] });
  } else if (msg.type === "WD_DONE") {
    if (!state.autofill.active) return;
    // In auto-advance mode the loop awaits each fill; hand the report to it and
    // keep `running` true (the loop, not this message, decides when we're done).
    // The per-step report was already appended via WD_PROGRESS, so don't re-add it.
    if (wdStepWaiter) {
      wdStepWaiter({ reports: msg.reports || [], aborted: !!msg.aborted });
      return;
    }
    // Late DONE after Stop already finished the loop — do not clobber the outcome.
    if (state.autofill.done && state.autofill.loopFinished) return;
    if (msg.aborted) {
      setAutofill({
        running: false,
        done: true,
        loopFinished: "stopped",
        loopMessage: "Autofill stopped.",
        loopStatus: null,
        reports: msg.reports || state.autofill.reports,
      });
      return;
    }
    setAutofill({ running: false, done: true, reports: msg.reports || state.autofill.reports });
  } else if (msg.type === "WD_ERROR") {
    if (!state.autofill.active) return;
    if (wdStepWaiter) {
      wdStepWaiter({ error: msg.error || "Autofill failed" });
      return;
    }
    if (state.autofill.done && state.autofill.loopFinished) return;
    setAutofill({ running: false, done: true, error: msg.error || "Autofill failed", reports: msg.reports || state.autofill.reports });
  } else if (msg.type === "WD_RESOLVE") {
    // Ignore LLM resolve replies after Stop — page waiters were already cleared.
    if (state.autofill.loopStop || !state.autofill.running) {
      const tabId = state.autofill.tabId;
      if (tabId != null && msg.requestId) {
        try {
          chrome.tabs.sendMessage(tabId, { type: "WD_RESOLVE_RESULT", requestId: msg.requestId, values: {} });
        } catch {}
      }
      return;
    }
    handleWorkdayResolve(msg);
  }
}

// The Workday engine asks us to resolve option values it cannot decide locally
// (e.g. map the candidate's profile degree to the dropdown's exact options). We
// reuse the LLM autofill endpoint (profile + job aware, option-snapped) and send
// the chosen option(s) back to the page, keyed by the control id. Always replies
// (even with {}) so the engine's await never hangs.
async function handleWorkdayResolve(msg) {
  const af = state.autofill;
  const job = state.job;
  const tabId = af && af.tabId;
  const reply = (values) => {
    if (tabId == null) return;
    try {
      chrome.tabs.sendMessage(tabId, { type: "WD_RESOLVE_RESULT", requestId: msg.requestId, values: values || {} });
    } catch {
      /* tab may be gone */
    }
  };
  try {
    const items = Array.isArray(msg.items) ? msg.items : [];
    if (!job || !job.job_id || !items.length) {
      console.debug("[workday] WD_RESOLVE skipped:", {
        hasJob: !!job,
        jobId: job && job.job_id,
        itemCount: items.length,
      });
      return reply({});
    }
    const controls = items.map((it) => ({
      cid: String(it.cid),
      kind: it.kind || "select",
      label: (it.label || "Field") + (it.want ? ` (candidate's value: ${it.want})` : ""),
      required: it.required !== false,
      options: Array.isArray(it.options) ? it.options.slice(0, 100) : [],
    }));
    const resp = await api.autofill(job.job_id, [{ handle: 0, label: "Workday fields", controls }], buildPreferences());
    const values = {};
    for (const f of (resp && resp.results) || []) {
      for (const c of f.controls || []) {
        if (c.needs_user) continue;
        const v = c.option || c.value;
        if (c.cid && v) values[c.cid] = v;
      }
    }
    console.debug(
      "[workday] WD_RESOLVE answered",
      Object.keys(values).length,
      "/",
      items.length,
      "controls",
    );
    reply(values);
  } catch (err) {
    console.warn("[workday] WD_RESOLVE failed:", (err && err.message) || err);
    reply({});
  }
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender) => onContentMessage(msg, sender));
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== null && v !== undefined && v !== false) {
      node.setAttribute(k, v);
    }
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function renderSpinner(label) {
  return el("div", { class: "center loading-state" }, [
    el("span", { class: "spinner" }),
    label ? el("span", { class: "muted" }, label) : null,
  ]);
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── lightweight, safe markdown (assistant answers) ───────────────────────────
// Inline formatting on ALREADY HTML-escaped text. Supports bold, italic, inline
// code, and http(s) links. Order matters: bold before italic so ** isn't eaten.
function mdInline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+?)\*/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

// Block-level markdown -> safe HTML. Everything is HTML-escaped first, so this
// can never inject markup. Tolerant of partial text (used during streaming).
function renderMarkdown(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  let listType = null; // "ul" | "ol"
  let para = [];
  let inCode = false;
  let code = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p class="md-p">${para.join("<br>")}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        flushPara();
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const t = line.trim();
    if (!t) {
      flushPara();
      closeList();
      continue;
    }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(t))) {
      flushPara();
      closeList();
      const lvl = Math.min(m[1].length, 4);
      out.push(`<div class="md-h md-h${lvl}">${mdInline(escapeHtml(m[2]))}</div>`);
    } else if ((m = /^[-*]\s+(.*)$/.exec(t))) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        out.push('<ul class="md-ul">');
        listType = "ul";
      }
      out.push(`<li>${mdInline(escapeHtml(m[1]))}</li>`);
    } else if ((m = /^\d+\.\s+(.*)$/.exec(t))) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        out.push('<ol class="md-ol">');
        listType = "ol";
      }
      out.push(`<li>${mdInline(escapeHtml(m[1]))}</li>`);
    } else if ((m = /^>\s?(.*)$/.exec(t))) {
      flushPara();
      closeList();
      out.push(`<blockquote class="md-q">${mdInline(escapeHtml(m[1]))}</blockquote>`);
    } else {
      closeList();
      para.push(mdInline(escapeHtml(line)));
    }
  }
  if (inCode && code.length) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushPara();
  closeList();
  return out.join("");
}

// Strip markdown to plain text for copying - what you copy matches what you read.
function mdToPlain(text) {
  let s = String(text || "");
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => c.trim());
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/\*\*([^*]+?)\*\*/g, "$1");
  s = s.replace(/__([^_]+?)__/g, "$1");
  s = s.replace(/\*([^*\n]+?)\*/g, "$1");
  s = s.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1");
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

// Imperative toast — avoid a full re-render (and scroll jump) just to show a tip.
let toastTimer = null;
let toastText = null;
function toast(msg) {
  toastText = String(msg || "");
  if (!toastText) return;
  paintToast();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    toastText = null;
    const node = root.querySelector(".toast");
    if (node) node.remove();
  }, 3500);
}

function paintToast() {
  if (!toastText) return;
  let node = root.querySelector(".toast");
  if (!node) {
    node = el("div", { class: "toast" }, toastText);
    root.appendChild(node);
  } else {
    node.textContent = toastText;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text || "");
    toast("Copied");
  } catch {
    toast("Copy failed");
  }
}

async function copyAnswer(text, btn) {
  try {
    await navigator.clipboard.writeText(text || "");
    if (btn) {
      btn.classList.add("is-copied");
      const label = btn.querySelector(".copy-btn-label");
      const ico = btn.querySelector(".copy-btn-ico");
      if (label) label.textContent = "Copied";
      if (ico) ico.innerHTML = ICON_CHECK;
      window.setTimeout(() => {
        btn.classList.remove("is-copied");
        if (label) label.textContent = "Copy";
        if (ico) ico.innerHTML = ICON_COPY;
      }, 1600);
    } else {
      toast("Copied");
    }
  } catch {
    toast("Copy failed");
  }
}

// ── init ────────────────────────────────────────────────────────────────────

async function init() {
  await store.syncBackendFromOpenTabs();
  const [user, token, minScore, autoAdvance, resumeSource, answerStrategy, pageSize, askHotkey] =
    await Promise.all([
      store.getCurrentUser(),
      store.getToken(),
      store.getMinScore(),
      store.getAutoAdvance(),
      store.getResumeSource(),
      store.getAnswerStrategy(),
      store.getPageSize(),
      store.getAskHotkey(),
    ]);
  state.minScore = minScore;
  state.autoAdvance = autoAdvance !== false;
  state.resumeSource = resumeSource === "original" ? "original" : "tailored";
  state.answerStrategy = answerStrategy || "";
  state.pageSize = pageSize;
  state.askHotkey = askHotkey;
  if (user && token) {
    state.user = user;
    state.cache = await store.getCache(user.user_id);
    await goHome();
    await consumePendingWebappJob();
    await consumePendingAskSelection();
    await consumePendingAppSubmitted();
  } else {
    const remembered = await store.getRememberedEmail();
    loginDraft = { email: remembered, password: "", remember: Boolean(remembered), showPassword: false };
    setState({ view: "login" });
  }
}

// ── auth actions ─────────────────────────────────────────────────────────────

async function doLogin(email, password) {
  setState({ error: null, loginLoading: true });
  await store.syncBackendFromOpenTabs();
  const backendUrl = await store.getBackendUrl();
  const granted = await api.ensureHostPermission(backendUrl);
  if (!granted) {
    setState({ error: "Permission to access the backend was denied.", loginLoading: false });
    return;
  }
  try {
    const user = await api.login(backendUrl, email, password);
    if (loginDraft.remember) await store.setRememberedEmail(email);
    else await store.setRememberedEmail("");
    state.user = user;
    state.minScore = await store.getMinScore();
    await syncNow(); // first load populates the cache
    await goHome();
    await consumePendingWebappJob();
  } catch (err) {
    setState({ error: err.message || "Login failed.", loginLoading: false });
  }
}

async function doLogout() {
  stopHomePolling();
  const uid = state.user && state.user.user_id;
  if (uid) await store.clearJobsCatalog(uid);
  jobsCatalog = null;
  await api.logout();
  await store.clearCurrentUser();
  const remembered = await store.getRememberedEmail();
  loginDraft = { email: remembered, password: "", remember: Boolean(remembered), showPassword: false };
  setState({ view: "login", user: null, cache: null, sync: null, job: null, queue: [], sessions: [] });
}

// ── data / sync ──────────────────────────────────────────────────────────────

async function syncNow() {
  const [profile, profileText, settings, version] = await Promise.all([
    api.getProfile().catch(() => null),
    api.getProfileText().catch(() => null),
    api.getSettings().catch(() => null),
    api.getDataVersion().catch(() => null),
  ]);
  const cache = {
    profile,
    profileText: profileText && profileText.profile_openai_text,
    settings,
    dataVersion: version,
  };
  await store.setCache(state.user.user_id, cache);
  state.cache = await store.getCache(state.user.user_id);
  state.sync = null;
}

async function checkSync() {
  try {
    const version = await api.getDataVersion();
    const prev = state.cache && state.cache.dataVersion;
    if (!prev || !version) return;
    const changed = [];
    for (const [section, hash] of Object.entries(version.sections || {})) {
      if (!prev.sections || prev.sections[section] !== hash) changed.push(section);
    }
    if (changed.length) setState({ sync: { changed } });
  } catch {
    /* ignore sync check failures */
  }
}

async function goHome() {
  await teardownAutofill();
  try {
    await chrome.runtime.sendMessage({ type: "ASK_HOTKEY_DISARM" });
  } catch {
    /* ignore */
  }
  setState({
    view: "home",
    job: null,
    reportNotice: null,
    homeTab: "hub",
    applyListContext: null,
  });
  // Paint cached lists immediately, then sync in the background.
  const hadCache = await hydrateCatalogFromStorage();
  await Promise.all([loadQueue({ silent: hadCache }), checkSync()]);
  startHomePolling();
}

async function ensureAskHotkeyOnActiveTab({ requestPermission = false, jobUrl = null } = {}) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageUrl = (tab && tab.url) || jobUrl || "";
    const engine = resolveEngine({
      snapshot: state.job && state.job.snapshot,
      pageUrl,
    });
    // Include ATS iframe hosts (e.g. Greenhouse embeds) so selection hotkeys work there.
    let origins = autofillPermissionOrigins(pageUrl || jobUrl, engine && engine.platform);
    if (!origins.length && jobUrl) {
      try {
        origins = [`${new URL(jobUrl).origin}/*`];
      } catch {
        origins = [];
      }
    }
    if (!origins.length) return;
    const has = await chrome.permissions.contains({ origins });
    if (!has) {
      if (!requestPermission) return;
      const granted = await chrome.permissions.request({ origins });
      if (!granted) {
        toast("Allow page access in the prompt so the ask hotkey can read your selection.");
        return;
      }
    }
    await chrome.storage.session.set({ askHotkeyArmed: true });
    if (tab && tab.id != null && /^https?:/i.test(tab.url || "")) {
      await chrome.runtime.sendMessage({ type: "ASK_HOTKEY_INJECT", tabId: tab.id });
    }
  } catch (err) {
    console.warn("ensureAskHotkeyOnActiveTab failed", err);
  }
}

async function handleAskSelectionMessage(msg) {
  const now = Date.now();
  if (now - lastAskSelectionAt < 400) return;
  lastAskSelectionAt = now;
  try {
    await chrome.storage.session.remove("pendingAskSelection");
  } catch {
    /* ignore */
  }

  const text = String((msg && msg.text) || "").trim();
  if (!text || (msg && msg.empty)) {
    toast("Select question text on the application page, then press the hotkey.");
    return;
  }
  if (!state.user) {
    toast("Sign in to ask the assistant.");
    return;
  }
  if (state.view !== "job" || !state.job) {
    toast("Open an application in the assistant first, then use the hotkey.");
    return;
  }
  if (state.streaming) {
    toast("Wait for the current answer to finish.");
    return;
  }
  toast("Asking about your selection…");
  await askQuestion(text);
}

async function consumePendingAskSelection() {
  try {
    const data = await chrome.storage.session.get("pendingAskSelection");
    const pending = data && data.pendingAskSelection;
    if (!pending || !pending.at) return;
    // Ignore stale stashes (e.g. from a previous browser session).
    if (Date.now() - Number(pending.at) > 30_000) {
      await chrome.storage.session.remove("pendingAskSelection");
      return;
    }
    await handleAskSelectionMessage(pending);
  } catch (err) {
    console.warn("consumePendingAskSelection failed", err);
  }
}

function openHomeSection(id) {
  const pageByTab = { ...state.pageByTab };
  if (pageByTab[id] != null) pageByTab[id] = 1;
  const patch = { homeTab: id, pageByTab };
  if (id === "tailor") {
    // Job list work-mode filter must not hide resumes (they have no work mode).
    patch.listFilters = { ...getListFilters(), workMode: "" };
  }
  setState(patch, { resetScroll: true });
  if (id === "tailor") void loadTailorResumes();
  if (id === "stats") void loadStatsPeriod(state.statsPeriod || "week");
}

function backToHub() {
  stopAskHotkeyRecording();
  setState({ homeTab: "hub" }, { resetScroll: true });
}

// Soft-refresh home lists while the panel stays open (dashboard polls ~6s while
// pipelines run). Keep it quiet — no skeleton flash on background refresh.
let homePollTimer = null;
function stopHomePolling() {
  if (homePollTimer != null) {
    clearInterval(homePollTimer);
    homePollTimer = null;
  }
}
function startHomePolling() {
  stopHomePolling();
  homePollTimer = setInterval(() => {
    if (state.view !== "home" || state.queueLoading) return;
    void loadQueueSilent();
  }, 6000);
}

async function loadQueueSilent() {
  if (state.queueLoading) return;
  await loadQueue({ silent: true });
}

function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Optional min-score query param — omit when 0 so we match the dashboard. */
function minScoreParam() {
  const n = Number(state.minScore);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// In-memory job catalog (mirrors chrome.storage / IndexedDB). Lists are derived.
let jobsCatalog = null;

function localDayBoundsMs() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

function tsInLocalDay(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const { startMs, endMs } = localDayBoundsMs();
  return t >= startMs && t < endMs;
}

function jobSortTs(j, key) {
  if (key === "match_score") {
    const n = Number(j && j.match_overall_score);
    return Number.isFinite(n) ? n : -1;
  }
  if (key === "applied_at") return Date.parse((j && j.applied_at) || 0) || 0;
  return Date.parse((j && (j.created_at || j.posted_date)) || 0) || 0;
}

function sortJobs(items, key, order) {
  const dir = order === "asc" ? 1 : -1;
  return (items || []).slice().sort((a, b) => {
    const d = (jobSortTs(a, key) - jobSortTs(b, key)) * dir;
    if (d !== 0) return d;
    return String((b && b.id) || "").localeCompare(String((a && a.id) || ""));
  });
}

function isRemoteJob(j) {
  if (!j) return false;
  if (j.is_remote) return true;
  if (String(j.work_mode || "").toLowerCase() === "remote") return true;
  return /remote/i.test(String(j.location || ""));
}

function isJobApplied(j) {
  return !!(j && j.applied_at);
}

/** Resume DOCX completed and not yet marked applied — matches "Ready to apply". */
function isReadyJob(j) {
  if (!j || isJobApplied(j)) return false;
  return String(j.resume_build_status || j.resume_docx_status || "").toLowerCase() === "completed";
}

/** Derive all Home queues + count tiles from the canonical jobsById map. */
function deriveHomeFromCatalog(catalog) {
  const jobsById = (catalog && catalog.jobsById) || {};
  const all = Object.values(jobsById);
  const bestFloor = state.BEST_MATCH_SCORE || 75;
  const todayAll = sortJobs(
    all.filter((j) => tsInLocalDay(j.pool_added_at || j.created_at)),
    "created_at",
    "desc"
  );
  const todayMine = todayAll.filter((j) => isFromMe(j));
  const todayPlatform = todayAll.filter((j) => !isFromMe(j));
  const queue = sortJobs(all, "created_at", "desc");
  const readyQueue = sortJobs(all.filter(isReadyJob), "match_score", "desc");
  const bestQueue = sortJobs(
    all.filter((j) => Number(j.match_overall_score) >= bestFloor),
    "match_score",
    "desc"
  );
  const remoteQueue = sortJobs(all.filter(isRemoteJob), "created_at", "desc");
  const mineQueue = sortJobs(all.filter((j) => isFromMe(j)), "created_at", "desc");
  const appliedQueue = sortJobs(
    all.filter((j) => tsInLocalDay(j.applied_at)),
    "applied_at",
    "desc"
  );

  const meta = (catalog && catalog.meta) || {};
  const counts = meta.dashboardCounts || {};
  const dashboardCounts = {
    all: counts.all != null ? counts.all : queue.length,
    today: counts.today != null ? counts.today : todayAll.length,
    mine: counts.mine != null ? counts.mine : mineQueue.length,
    suggested: counts.suggested != null ? counts.suggested : 0,
    applied_today: counts.applied_today != null ? counts.applied_today : appliedQueue.length,
  };
  const ss = meta.scraperStats || {};
  // Prefer server tiles when present, but always derive `ready` from the local
  // catalog so Complete & Next immediately drops applied jobs from the badge.
  const platformCounts = {
    ...(meta.platformCounts || {
      total: ss.total_jobs != null ? ss.total_jobs : dashboardCounts.all,
      best: ss.best_jobs != null ? ss.best_jobs : bestQueue.length,
      today: ss.today_scraped != null ? ss.today_scraped : dashboardCounts.today,
      remote: ss.total_remote != null ? ss.total_remote : remoteQueue.length,
      mine: ss.my_jobs != null ? ss.my_jobs : dashboardCounts.mine,
    }),
    ready: readyQueue.length,
  };

  return {
    queue,
    readyQueue,
    bestQueue,
    remoteQueue,
    mineQueue,
    todayQueue: todayAll,
    todayPlatformQueue: todayPlatform,
    todayMineQueue: todayMine,
    todayCounts: {
      all: dashboardCounts.today,
      platform: todayPlatform.length,
      mine: todayMine.length,
    },
    dashboardCounts,
    platformCounts,
    weeklyProgress: meta.weeklyProgress != null ? meta.weeklyProgress : state.weeklyProgress,
    scraperStats: meta.scraperStats != null ? meta.scraperStats : state.scraperStats,
    appliedQueue,
    pumbleConfigured: !!meta.pumbleConfigured,
    pumbleDestinationCount: meta.pumbleDestinationCount || 0,
    sessions: meta.sessions != null ? meta.sessions : state.sessions,
  };
}

function catalogServerTimeIso(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === "string") return value;
  try {
    return new Date(value).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function buildMetaFromExtras(extras, counts, catalog) {
  const prev = (catalog && catalog.meta) || {};
  const ss = extras.scraperStats || prev.scraperStats || {};
  const dashboardCounts = {
    all: counts && counts.all != null ? counts.all : prev.dashboardCounts?.all,
    today: counts && counts.today != null ? counts.today : prev.dashboardCounts?.today,
    mine: counts && counts.mine != null ? counts.mine : prev.dashboardCounts?.mine,
    suggested: counts && counts.suggested != null ? counts.suggested : prev.dashboardCounts?.suggested || 0,
    applied_today:
      counts && counts.applied_today != null
        ? counts.applied_today
        : prev.dashboardCounts?.applied_today,
  };
  const platformCounts = {
    total: ss.total_jobs != null ? ss.total_jobs : dashboardCounts.all,
    ready: ss.ready_jobs != null ? ss.ready_jobs : prev.platformCounts?.ready,
    best: ss.best_jobs != null ? ss.best_jobs : prev.platformCounts?.best,
    today: ss.today_scraped != null ? ss.today_scraped : dashboardCounts.today,
    remote: ss.total_remote != null ? ss.total_remote : prev.platformCounts?.remote,
    mine: ss.my_jobs != null ? ss.my_jobs : dashboardCounts.mine,
  };
  return {
    ...prev,
    dashboardCounts,
    platformCounts,
    weeklyProgress:
      extras.weeklyProgress != null ? extras.weeklyProgress : prev.weeklyProgress,
    scraperStats: extras.scraperStats != null ? extras.scraperStats : prev.scraperStats,
    sessions: extras.sessions != null ? extras.sessions : prev.sessions,
    pumbleConfigured: extras.pumbleConfigured,
    pumbleDestinationCount: extras.pumbleDestinationCount,
  };
}

function applyHomeFromCatalog(catalog, { silent = false, resetPages = false } = {}) {
  jobsCatalog = catalog;
  const nextHome = deriveHomeFromCatalog(catalog);
  if (silent && !state.queueLoading && homeDataUnchanged(state, nextHome)) {
    return false;
  }
  const syncedRuns = syncTailorRunsFromJobs([
    ...(nextHome.queue || []),
    ...(nextHome.todayQueue || []),
    ...(nextHome.readyQueue || []),
  ]);
  setState({
    ...nextHome,
    ...(syncedRuns ? { tailorRuns: syncedRuns } : {}),
    ...(resetPages
      ? {
          pageByTab: {
            progress: 1,
            today: 1,
            all: 1,
            ready: 1,
            best: 1,
            remote: 1,
            mine: 1,
            tailor: 1,
          },
        }
      : {}),
    queueLoading: false,
  });
  return true;
}

async function persistJobsCatalog(catalog) {
  const uid = state.user && state.user.user_id;
  if (!uid || !catalog) return;
  jobsCatalog = catalog;
  await store.setJobsCatalog(uid, catalog);
}

async function hydrateCatalogFromStorage() {
  const uid = state.user && state.user.user_id;
  if (!uid) return false;
  try {
    const catalog = await store.getJobsCatalog(uid);
    if (!catalog || !catalog.jobsById) return false;
    const want = Number(state.minScore) || 0;
    if (Number(catalog.minScore) !== want) return false;
    if (!Object.keys(catalog.jobsById).length && !catalog.since) return false;
    applyHomeFromCatalog(catalog, { silent: true, resetPages: false });
    return true;
  } catch (err) {
    console.warn("hydrateCatalogFromStorage failed", err);
    return false;
  }
}

async function patchCatalogJobs(mutator) {
  if (!jobsCatalog || !jobsCatalog.jobsById) return;
  const next = mutator({
    ...jobsCatalog,
    jobsById: { ...jobsCatalog.jobsById },
    meta: { ...(jobsCatalog.meta || {}) },
  });
  if (!next) return;
  await persistJobsCatalog(next);
  applyHomeFromCatalog(next, { silent: true, resetPages: false });
}

async function patchCatalogJob(jobId, patch) {
  const id = String(jobId || "");
  if (!id) return;
  await patchCatalogJobs((cat) => {
    const cur = cat.jobsById[id];
    if (!cur) return null;
    cat.jobsById[id] = { ...cur, ...patch };
    return cat;
  });
}

async function removeCatalogJob(jobId) {
  const id = String(jobId || "");
  if (!id) return;
  await patchCatalogJobs((cat) => {
    if (!cat.jobsById[id]) return null;
    delete cat.jobsById[id];
    return cat;
  });
}

// The dashboard caps per_page at 200. Page through a view for cold bootstrap.
async function fetchDashboardPages({
  view = "all",
  sort = "created_at",
  order = "desc",
  min_match_score,
  remote_only = false,
  maxPages = 50,
} = {}) {
  const timezone = localTimezone();
  const first = await api
    .getDashboard({
      view,
      per_page: 200,
      page: 1,
      sort,
      order,
      timezone,
      min_match_score,
      remote_only,
    })
    .catch(() => ({ items: [], pages: 1, total: 0 }));
  let items = first.items || [];
  const total = first.total != null ? first.total : items.length;
  const pages = Math.min(first.pages || 1, maxPages);
  if (pages > 1) {
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, i) =>
        api
          .getDashboard({
            view,
            per_page: 200,
            page: i + 2,
            sort,
            order,
            timezone,
            min_match_score,
            remote_only,
          })
          .catch(() => ({ items: [] }))
      )
    );
    for (const r of rest) items = items.concat(r.items || []);
  }
  return { items, total: Math.max(total, items.length) };
}

function isFromMe(j) {
  return !!(j && j.from_me);
}

/** Compact signature so silent polls can skip a no-op re-render. */
function jobsListSig(items) {
  return (items || [])
    .map((j) =>
      [
        j.id,
        j.match_overall_score,
        j.applied_at || "",
        j.resume_pdf_status || "",
        j.resume_build_status || "",
        j.content_generation_status || "",
        j.resume_build_id || "",
        j.cover_letter_pdf_status || "",
        j.title || "",
        j.company || "",
        j.work_mode || "",
        j.source || "",
        j.posted_date || j.created_at || "",
      ].join("\x1f")
    )
    .join("\x1e");
}

function sessionsListSig(items) {
  return (items || [])
    .map((s) =>
      [
        s.id,
        s.status || "",
        s.updated_at || s.created_at || "",
        s.job_title || "",
        s.company || "",
        s.job_id || "",
      ].join("\x1f")
    )
    .join("\x1e");
}

function homeDataUnchanged(prev, next) {
  if (prev.pumbleConfigured !== next.pumbleConfigured) return false;
  if (prev.pumbleDestinationCount !== next.pumbleDestinationCount) return false;
  if (JSON.stringify(prev.dashboardCounts || {}) !== JSON.stringify(next.dashboardCounts || {})) {
    return false;
  }
  if (JSON.stringify(prev.platformCounts || {}) !== JSON.stringify(next.platformCounts || {})) {
    return false;
  }
  if (JSON.stringify(prev.weeklyProgress || null) !== JSON.stringify(next.weeklyProgress || null)) {
    return false;
  }
  if (JSON.stringify(prev.scraperStats || null) !== JSON.stringify(next.scraperStats || null)) {
    return false;
  }
  if (sessionsListSig(prev.sessions) !== sessionsListSig(next.sessions)) return false;
  if (jobsListSig(prev.queue) !== jobsListSig(next.queue)) return false;
  if (jobsListSig(prev.readyQueue) !== jobsListSig(next.readyQueue)) return false;
  if (jobsListSig(prev.bestQueue) !== jobsListSig(next.bestQueue)) return false;
  if (jobsListSig(prev.remoteQueue) !== jobsListSig(next.remoteQueue)) return false;
  if (jobsListSig(prev.mineQueue) !== jobsListSig(next.mineQueue)) return false;
  if (jobsListSig(prev.todayQueue) !== jobsListSig(next.todayQueue)) return false;
  if (jobsListSig(prev.appliedQueue) !== jobsListSig(next.appliedQueue)) return false;
  return true;
}

async function fetchHomeExtras({ timezone, score }) {
  const [sessions, weekly, scraperStats, pumbleCfg] = await Promise.all([
    api.listSessions("in_progress").catch(() => []),
    api.getWeeklyProgress({ timezone, days: 7 }).catch(() => null),
    api.getScraperStats({ timezone }).catch(() => null),
    api.getPumbleConfig().catch(() => ({ configured: false })),
  ]);
  const pumbleConfigured = Boolean(
    pumbleCfg &&
      ((Array.isArray(pumbleCfg.integrations) && pumbleCfg.integrations.length > 0) ||
        pumbleCfg.configured)
  );
  const pumbleDestinationCount = Array.isArray(pumbleCfg?.integrations)
    ? pumbleCfg.integrations.filter((i) => i.is_enabled !== false).length
    : pumbleCfg?.configured
      ? 1
      : 0;
  return {
    sessions: sessions || [],
    weeklyProgress: weekly,
    scraperStats,
    pumbleConfigured,
    pumbleDestinationCount,
  };
}

async function bootstrapJobsCatalog({ score, wantScore, timezone, extras }) {
  const [allPage, counts, revision] = await Promise.all([
    fetchDashboardPages({
      view: "all",
      sort: "created_at",
      order: "desc",
      min_match_score: score,
    }),
    api.getDashboardCounts({ timezone, min_match_score: score }).catch(() => null),
    api.getDashboardRevision({ min_match_score: score }).catch(() => null),
  ]);
  const meta = buildMetaFromExtras(extras, counts, jobsCatalog);
  const since = catalogServerTimeIso(revision && revision.server_time);
  const catalog = store.replaceJobsCatalog(jobsCatalog, allPage.items || [], {
    since,
    revision: revision && revision.revision,
    minScore: wantScore,
    meta,
  });
  await persistJobsCatalog(catalog);
  return catalog;
}

async function loadQueue({ silent = false } = {}) {
  // Show skeletons while cold-loading — skip the flash on background polls /
  // when we already painted from cache.
  if (!silent) setState({ queueLoading: true });
  try {
    const score = minScoreParam();
    const wantScore = Number(state.minScore) || 0;
    const timezone = localTimezone();

    // Silent warm poll: skip network entirely when revision is unchanged.
    if (silent && jobsCatalog && jobsCatalog.revision) {
      const rev = await api.getDashboardRevision({ min_match_score: score }).catch(() => null);
      if (rev && rev.revision === jobsCatalog.revision) {
        return;
      }
    }

    const extras = await fetchHomeExtras({ timezone, score });
    const needBootstrap =
      !jobsCatalog ||
      !jobsCatalog.since ||
      Number(jobsCatalog.minScore) !== wantScore ||
      !jobsCatalog.jobsById;

    let catalog;
    if (needBootstrap) {
      catalog = await bootstrapJobsCatalog({ score, wantScore, timezone, extras });
    } else {
      const knownIds = Object.keys(jobsCatalog.jobsById || {});
      const sync = await api
        .getDashboardSync({
          since: jobsCatalog.since,
          timezone,
          min_match_score: score,
          known_ids: knownIds.length <= 2000 ? knownIds : undefined,
        })
        .catch(() => null);

      if (!sync || sync.reset) {
        catalog = await bootstrapJobsCatalog({ score, wantScore, timezone, extras });
      } else {
        const meta = buildMetaFromExtras(extras, sync.counts, jobsCatalog);
        catalog = store.mergeJobsCatalog(jobsCatalog, {
          upserts: sync.upserts || [],
          removed_ids: sync.removed_ids || [],
          since: catalogServerTimeIso(sync.server_time),
          revision: sync.revision,
          meta,
        });
        catalog.minScore = wantScore;
        await persistJobsCatalog(catalog);
      }
    }

    applyHomeFromCatalog(catalog, { silent, resetPages: !silent });
  } catch (err) {
    setState({ error: silent ? state.error : err.message, queueLoading: false });
  }
}

function syncTailorRunsFromJobs(jobs) {
  const runs = state.tailorRuns || [];
  if (!runs.length) return null;
  const byId = new Map((jobs || []).filter((j) => j && j.id).map((j) => [j.id, j]));
  let changed = false;
  const next = runs.map((r) => {
    if (r.kind !== "job" || r.status !== "running" || !r.jobId) return r;
    const j = byId.get(r.jobId);
    if (!j) return r;
    if (jobResumeReady(j)) {
      changed = true;
      return { ...r, status: "done", stage: "done", label: "Content ready" };
    }
    if (jobResumeFailed(j)) {
      changed = true;
      return {
        ...r,
        status: "error",
        stage: "error",
        label: resumeProgressLabel(j),
        error: resumeProgressLabel(j),
      };
    }
    const label = resumeProgressLabel(j);
    if (label && label !== r.label) {
      changed = true;
      return { ...r, label, stage: "processing" };
    }
    return r;
  });
  return changed ? next : null;
}

async function applyMinScore(value) {
  const n = await store.setMinScore(value);
  setState({ minScore: n });
  await loadQueue();
}

// ── job / chat actions ───────────────────────────────────────────────────────

// The dashboard's "Apply with Assistant" button stores a job for us to open
// (via the background worker). Pick it up once the user is authenticated; the
// application URL was already opened in its own tab, so no redirect here.
async function consumePendingWebappJob() {
  try {
    if (!state.user) return; // not logged in yet; consume after login instead
    const data = await chrome.storage.session.get("pendingWebappJob");
    const pending = data && data.pendingWebappJob;
    if (!pending || !pending.jobId) return;
    await chrome.storage.session.remove("pendingWebappJob");
    await openJob(String(pending.jobId), { redirect: false });
  } catch (err) {
    console.warn("consumePendingWebappJob failed", err);
  }
}

/**
 * List-context for Complete & Next — mirrors the hub section the user opened.
 * jobIds preserve the filtered UI order so "next" matches what they see.
 */
function applyContextForTab(tabId, jobIds) {
  const score = minScoreParam();
  const bestFloor = state.BEST_MATCH_SCORE || 75;
  const ids = (jobIds || []).map(String);
  switch (tabId) {
    case "best":
      return { key: "best", view: "all", min_match_score: bestFloor, jobIds: ids };
    case "remote":
      return {
        key: "remote",
        view: "all",
        remote_only: true,
        min_match_score: score,
        jobIds: ids,
      };
    case "mine":
      return { key: "mine", view: "mine", min_match_score: score, jobIds: ids };
    case "today":
      return { key: "today", view: "today", min_match_score: score, jobIds: ids };
    case "all":
      return { key: "all", view: "all", min_match_score: score, jobIds: ids };
    case "ready":
      return { key: "ready", view: "ready", min_match_score: score, jobIds: ids };
    case "progress":
      return { key: "progress", view: "ready", min_match_score: score, jobIds: ids };
    default:
      return { key: "ready", view: "ready", min_match_score: score, jobIds: ids };
  }
}

/** Rebind card clicks so Complete & Next advances within this visible list. */
function bindApplyListContext(tabId, cards) {
  const jobIds = (cards || []).map((c) => String(c.jobId));
  const ctx = applyContextForTab(tabId, jobIds);
  return (cards || []).map((c) => ({
    ...c,
    onClick: () => {
      setState({ applyListContext: { ...ctx, jobIds } });
      void openJob(c.jobId, { redirect: true });
    },
  }));
}

function catalogJobApplied(jobId) {
  const id = String(jobId || "");
  if (!id || !jobsCatalog || !jobsCatalog.jobsById) return false;
  return isJobApplied(jobsCatalog.jobsById[id]);
}

/**
 * Resolve the next job after Complete & Next / report-invalid.
 * Prefers the exact list the user opened; falls back to /assistant/next-job
 * with the same view filters.
 */
async function resolveNextJob(afterJobId) {
  const ctx = state.applyListContext;
  const after = String(afterJobId || "");
  if (ctx && Array.isArray(ctx.jobIds) && ctx.jobIds.length) {
    const original = ctx.jobIds.map(String).filter(Boolean);
    const isEligible = (id) => id && id !== after && !catalogJobApplied(id);
    const idxInOriginal = original.indexOf(after);
    let nextId = null;
    if (idxInOriginal >= 0) {
      // Strict forward advance within the opened list (no wrap-around).
      // Skip jobs already marked applied so Complete & Next never re-opens them.
      for (let i = idxInOriginal + 1; i < original.length; i++) {
        if (isEligible(original[i])) {
          nextId = original[i];
          break;
        }
      }
    } else {
      // Current job not in the cached list — take the first remaining entry.
      nextId = original.find(isEligible) || null;
    }
    if (nextId) {
      const nextJobIds = original.filter((id) => id !== nextId && isEligible(id));
      return {
        job_id: nextId,
        remaining: nextJobIds.length,
        source: "list",
        nextJobIds,
      };
    }
    // Exhausted this list — do not jump into a different view.
    return { job_id: null, remaining: 0, source: "list", nextJobIds: [] };
  }

  const opts = { timezone: localTimezone() };
  if (ctx) {
    if (ctx.view) opts.view = ctx.view;
    if (ctx.remote_only) opts.remote_only = true;
    if (ctx.min_match_score != null && ctx.min_match_score !== "") {
      opts.min_match_score = ctx.min_match_score;
    }
  } else {
    opts.view = "ready";
  }
  const nx = await api.nextJob(afterJobId, opts);
  return nx
    ? { ...nx, source: "api", nextJobIds: null }
    : { job_id: null, remaining: 0, source: "api", nextJobIds: null };
}

function listContextLabel(ctx) {
  if (!ctx || !ctx.key) return "ready";
  const labels = {
    ready: "ready",
    best: "best",
    remote: "remote",
    mine: "posted by me",
    today: "today",
    all: "all jobs",
    progress: "in progress",
  };
  return labels[ctx.key] || ctx.key;
}

async function openJob(jobId, { redirect = false, keepReportNotice = false } = {}) {
  stopHomePolling();
  if (state.streaming) stopStreaming();
  setState({
    view: "job",
    job: null,
    jdOpen: true,
    error: null,
    ...(keepReportNotice ? {} : { reportNotice: null }),
  });
  try {
    await api.createSession(jobId);
    // Fresh chat per application open — prior turns for this job must not linger.
    await api.clearSessionMessages(jobId).catch(() => {});
    const detail = await api.getSessionDetail(jobId);
    const snap = detail.job_snapshot || {};
    if (redirect && (snap.url || detail.job_url)) {
      await redirectActiveTab(snap.url || detail.job_url);
    }
    const docs = await loadJobDocsAvailability(jobId);
    setState({
      // Fresh application → JD expanded again; chat collapse happens in askQuestion.
      jdOpen: true,
      job: {
        job_id: jobId,
        url: snap.url || detail.job_url,
        title: snap.title || detail.job_title,
        company: snap.company || detail.company,
        score: snap.match_score,
        snapshot: snap,
        ready: !!snap.ready,
        applied: !!detail.applied_at,
        appliedAt: detail.applied_at || null,
        pumblePosted: jobHasPumblePosted(jobId),
        messages: [],
        docs,
        // Engine preview from the snapshot URL; re-resolved against the live tab
        // URL when autofill actually starts.
        engine: resolveEngine({ snapshot: snap }),
      },
    });
    // Arm selection→chat hotkey on the application tab (and future navigations).
    const applyUrl = snap.url || detail.job_url;
    void ensureAskHotkeyOnActiveTab({ requestPermission: true, jobUrl: applyUrl });
    if (redirect) {
      // Navigation is async — reinject after the application page settles.
      setTimeout(() => {
        void ensureAskHotkeyOnActiveTab({ requestPermission: false, jobUrl: applyUrl });
      }, 1800);
    }
    void consumePendingAskSelection();
    // Never re-consume a submit event after Complete & Next redirects — a stale
    // pendingAppSubmitted (rewritten by background after we cleared it) would
    // auto-complete the *next* job and skip its URL.
    if (!redirect) {
      void consumePendingAppSubmitted();
    }
    try {
      await chrome.storage.session.set({ activeApplyJobId: String(jobId) });
    } catch {
      /* ignore */
    }
    // Enable download buttons when tailored files finish after the panel opened.
    void pollJobDocs(jobId, 0);
  } catch (err) {
    setState({ error: err.message });
  }
}

function emptyJobDocs() {
  return {
    resumePdf: false,
    resumeDocx: false,
    coverPdf: false,
    coverDocx: false,
    loading: false,
  };
}

function docsSignature(docs) {
  const d = docs || emptyJobDocs();
  return [!!d.resumePdf, !!d.resumeDocx, !!d.coverPdf, !!d.coverDocx].join("|");
}

function docsBothReady(docs) {
  const d = docs || emptyJobDocs();
  return !!(d.resumePdf || d.resumeDocx) && !!(d.coverPdf || d.coverDocx);
}

function docsFromDashboardJob(j) {
  if (!j) return null;
  return {
    resumePdf: String(j.resume_pdf_status || "").toLowerCase() === "completed",
    resumeDocx: String(j.resume_build_status || j.resume_docx_status || "").toLowerCase() === "completed",
    coverPdf: String(j.cover_letter_pdf_status || "").toLowerCase() === "completed",
    coverDocx: String(j.cover_letter_docx_status || "").toLowerCase() === "completed",
    loading: false,
  };
}

async function loadJobDocsAvailability(jobId) {
  // Prefer live build status; fall back to dashboard queue fields already in memory.
  try {
    const st = await api.getResumeBuildStatus(jobId);
    // Keep the cached catalog in sync so Ready / Tailor lists update without a full refetch.
    void patchCatalogJob(jobId, {
      resume_build_status: st.resume_docx_status ?? null,
      resume_pdf_status: st.resume_pdf_status ?? null,
      cover_letter_pdf_status: st.cover_letter_pdf_status ?? null,
      content_generation_status: st.content_generation_status ?? null,
      ...(st.id || st.resume_build_id
        ? { resume_build_id: st.id || st.resume_build_id }
        : {}),
    });
    return {
      resumePdf: String(st.resume_pdf_status || "").toLowerCase() === "completed",
      resumeDocx: String(st.resume_docx_status || "").toLowerCase() === "completed",
      coverPdf: String(st.cover_letter_pdf_status || "").toLowerCase() === "completed",
      coverDocx: String(st.cover_letter_docx_status || "").toLowerCase() === "completed",
      loading: false,
    };
  } catch {
    /* 404 = no build yet */
  }
  const pools = [
    state.todayQueue,
    state.todayMineQueue,
    state.todayPlatformQueue,
    state.queue,
    state.appliedQueue,
  ];
  for (const pool of pools) {
    const match = (pool || []).find((j) => j && j.id === jobId);
    const docs = docsFromDashboardJob(match);
    if (docs && (docs.resumePdf || docs.resumeDocx || docs.coverPdf || docs.coverDocx)) {
      return docs;
    }
  }
  return emptyJobDocs();
}

async function pollJobDocs(jobId, attempt) {
  if (!state.job || state.job.job_id !== jobId || attempt > 36) return;
  if (docsBothReady(state.job.docs)) return;
  try {
    const docs = await loadJobDocsAvailability(jobId);
    if (!state.job || state.job.job_id !== jobId) return;
    if (docsSignature(docs) !== docsSignature(state.job.docs)) {
      setState({ job: { ...state.job, docs } });
    }
    if (docsBothReady(docs)) return;
  } catch {
    /* keep polling */
  }
  setTimeout(() => pollJobDocs(jobId, attempt + 1), 5000);
}

async function downloadJobDoc(jobId, fileTypes, label) {
  if (!jobId) return;
  const types = [].concat(fileTypes).filter(Boolean);
  if (!types.length) return;
  toast(`Preparing ${label}…`);
  let lastErr = null;
  for (const fileType of types) {
    try {
      const file = await api.downloadResumeFile(jobId, fileType);
      const binary = atob(file.base64 || "");
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: file.mime || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename || `${label.replace(/\s+/g, "_")}.${fileType.endsWith("docx") ? "docx" : "pdf"}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast(`${label} downloaded`);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  toast((lastErr && lastErr.message) || `Could not download ${label}.`);
}

async function redirectActiveTab(url) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) await chrome.tabs.update(tab.id, { url });
  } catch (err) {
    console.warn("redirectActiveTab failed", err);
  }
}

function jobHasPumblePosted(jobId) {
  const pools = [
    state.todayQueue,
    state.todayMineQueue,
    state.todayPlatformQueue,
    state.queue,
    state.appliedQueue,
  ];
  for (const pool of pools) {
    const match = (pool || []).find((j) => j.id === jobId);
    if (match && match.pumble_posted_at) return true;
  }
  return false;
}

async function runAnalysis() {
  if (!state.job) return;
  try {
    await api.triggerMatch(state.job.job_id);
    toast("Analysis started. This can take a moment...");
    // Poll the session snapshot until the JD is ready.
    pollReady(state.job.job_id, 0);
  } catch (err) {
    setState({ error: err.message });
  }
}

async function pollReady(jobId, attempt) {
  if (!state.job || state.job.job_id !== jobId || attempt > 20) return;
  try {
    await api.createSession(jobId); // refreshes snapshot if newly ready
    const detail = await api.getSessionDetail(jobId);
    const snap = detail.job_snapshot || {};
    if (snap.ready) {
      setState({
        job: { ...state.job, snapshot: snap, ready: true, score: snap.match_score, title: snap.title || state.job.title },
      });
      if (snap.match_score != null) {
        void patchCatalogJob(jobId, {
          match_overall_score: snap.match_score,
          match_in_progress: false,
          ...(snap.title ? { title: snap.title } : {}),
        });
      }
      void pollJobDocs(jobId, 0);
      return;
    }
  } catch {
    /* keep polling */
  }
  setTimeout(() => pollReady(jobId, attempt + 1), 4000);
}

async function askQuestion(message) {
  if (!state.job || state.streaming || !message.trim()) return;
  const job = state.job;
  const userMsg = { role: "user", content: message, _local: true };
  const assistantMsg = { role: "assistant", content: "", _streaming: true };
  job.messages = [...job.messages, userMsg, assistantMsg];
  const abort = new AbortController();
  // Free vertical space for the thread: collapse JD when chat starts. User can
  // still re-expand via the summary; that preference is kept in state.jdOpen.
  setState({ streaming: true, abort, jdOpen: false, job: { ...job } });

  await api.chatStream(
    {
      job_id: job.job_id,
      message,
      style: state.style,
      field_type: state.fieldType || null,
    },
    {
      signal: abort.signal,
      onDelta: (d) => {
        assistantMsg.content += d;
        // Update the streaming bubble in place to keep the composer/focus intact.
        const bubbles = root.querySelectorAll(".msg.assistant");
        const last = bubbles[bubbles.length - 1];
        if (last) {
          last.innerHTML =
            escapeHtml(assistantMsg.content).replace(/\n/g, "<br>") + '<span class="cursor">|</span>';
          const msgs = root.querySelector(".messages");
          if (msgs) msgs.scrollTop = msgs.scrollHeight;
        } else {
          setState({ job: { ...state.job } });
        }
      },
      onError: (msg) => {
        assistantMsg._streaming = false;
        if (!assistantMsg.content) assistantMsg.content = msg;
        setState({ streaming: false, abort: null, job: { ...state.job } });
      },
      onDone: () => {
        assistantMsg._streaming = false;
        setState({ streaming: false, abort: null, job: { ...state.job } });
      },
    }
  );
}

function stopStreaming() {
  if (state.abort) state.abort.abort();
  setState({ streaming: false, abort: null });
}

async function postJobsToPumble(jobIds) {
  const ids = [...new Set((jobIds || []).map((id) => String(id)).filter(Boolean))];
  if (!ids.length) return;
  if (!state.pumbleConfigured) {
    toast("Configure Pumble in Atomspace Settings first.");
    return;
  }
  setState({ postingToPumble: true, error: null });
  try {
    const data = await api.postJobsToPumble(ids);
    const posted = data.posted_count || 0;
    const failed = data.failed_count || 0;
    const skipped = data.skipped_already_in_thread || 0;
    const destCount = data.destination_count || 0;
    const parts = [];
    if (posted > 0) {
      const destSuffix = destCount > 1 ? ` across ${destCount} destinations` : "";
      parts.push(`Posted ${posted} job${posted === 1 ? "" : "s"} to Pumble${destSuffix}`);
    }
    if (skipped > 0) parts.push(`${skipped} already in today's thread`);
    if (failed > 0) parts.push(`${failed} failed`);
    toast(parts.length ? `${parts.join("; ")}.` : "No jobs were posted to Pumble.");
    if (posted > 0) {
      if (state.job && ids.includes(state.job.job_id)) {
        setState({ job: { ...state.job, pumblePosted: true } });
      }
      const postedAt = new Date().toISOString();
      await patchCatalogJobs((cat) => {
        let touched = false;
        for (const id of ids) {
          if (!cat.jobsById[id]) continue;
          cat.jobsById[id] = { ...cat.jobsById[id], pumble_posted_at: postedAt };
          touched = true;
        }
        return touched ? cat : null;
      });
      await loadQueue({ silent: true });
    }
  } catch (err) {
    setState({ error: err.message || "Failed to post to Pumble." });
  } finally {
    setState({ postingToPumble: false });
  }
}

let autoCompleteFromSubmit = false;
let lastAutoCompleteJobId = null;
let lastAutoCompleteAt = 0;
// Global advance mutex — outlives a single completeJob so Workday detect +
// submit-watch + pendingAppSubmitted cannot Complete & Next job B immediately
// after advancing A→B (which marks B applied and jumps to C).
let completeInFlight = false;
let completingJobId = null;
let lastAdvanceCompletedAt = 0;
const ADVANCE_COOLDOWN_MS = 12_000;

async function completeJob({ next }) {
  if (!state.job) return;
  const jobId = state.job.job_id;
  if (completeInFlight) return;
  if (completingJobId === jobId) return;
  completeInFlight = true;
  completingJobId = jobId;
  let advancedOk = false;
  try {
    try {
      await chrome.storage.session.remove("pendingAppSubmitted");
    } catch {
      /* ignore */
    }
    await teardownAutofill();
    try {
      const marked = await api.markApplied([jobId]);
      if (!marked || !(Number(marked.marked) > 0)) {
        throw new Error("Could not mark this job as applied. Try again.");
      }
      await api.updateSession(jobId, "completed").catch(() => {});
      // Await so readyQueue / resolveNextJob see applied_at before advancing.
      await patchCatalogJob(jobId, {
        applied_at: marked.applied_at || new Date().toISOString(),
        applied_by_name: marked.applied_by_name || null,
      });
    } catch (err) {
      setState({ error: err.message });
      return;
    }
    if (next) {
      try {
        const listLabel = listContextLabel(state.applyListContext);
        const nx = await resolveNextJob(jobId);
        if (nx && nx.job_id) {
          if (state.applyListContext && Array.isArray(nx.nextJobIds)) {
            setState({
              applyListContext: {
                ...state.applyListContext,
                jobIds: nx.nextJobIds,
              },
            });
          }
          await openJob(nx.job_id, { redirect: true });
          const rem = nx.remaining != null ? nx.remaining : 0;
          toast(`Loaded next ${listLabel} job (${rem} remaining).`);
          advancedOk = true;
          return;
        }
        toast(`No more jobs in this list (${listLabel}).`);
        await goHome();
        advancedOk = true;
      } catch (err) {
        setState({ error: err.message });
      }
    } else {
      // Complete & Exit closes the side panel.
      window.close();
    }
  } finally {
    if (next && advancedOk) {
      lastAdvanceCompletedAt = Date.now();
      lastAutoCompleteJobId = jobId;
      lastAutoCompleteAt = lastAdvanceCompletedAt;
      // Hold the lock across the next-job load so late APP_SUBMITTED / pending
      // cannot auto-complete the freshly opened job.
      setTimeout(() => {
        if (completingJobId === jobId) {
          completeInFlight = false;
          completingJobId = null;
        }
      }, ADVANCE_COOLDOWN_MS);
    } else {
      completeInFlight = false;
      completingJobId = null;
    }
  }
}

/** Page submit detected → same path as Complete & Next. */
async function handleApplicationSubmitted(msg) {
  try {
    await chrome.storage.session.remove("pendingAppSubmitted");
  } catch {
    /* ignore */
  }
  if (completeInFlight || autoCompleteFromSubmit) return;
  // A run in flight is still working through the form - on multi-step platforms
  // it submits intermediate steps itself. Completing the job here would tear the
  // session down mid-application and advance to the next job.
  if (state.autofill && state.autofill.running) return;
  const now = Date.now();
  // After A→B, ignore submit signals for a cooldown regardless of job id.
  if (lastAdvanceCompletedAt && now - lastAdvanceCompletedAt < ADVANCE_COOLDOWN_MS) return;
  if (state.view !== "job" || !state.job || !state.job.job_id) return;
  if (state.job.applied) return;
  const jobId = state.job.job_id;
  const msgJobId = msg && msg.jobId != null ? String(msg.jobId) : "";
  // Stale submit for a previous job must never complete the current one.
  if (msgJobId && msgJobId !== String(jobId)) return;
  if (lastAutoCompleteJobId === jobId && now - lastAutoCompleteAt < 8000) return;
  lastAutoCompleteJobId = jobId;
  lastAutoCompleteAt = now;
  autoCompleteFromSubmit = true;
  try {
    toast("Application submitted — completing & loading next…");
    await completeJob({ next: true });
  } finally {
    autoCompleteFromSubmit = false;
  }
}

async function consumePendingAppSubmitted() {
  try {
    const data = await chrome.storage.session.get("pendingAppSubmitted");
    const pending = data && data.pendingAppSubmitted;
    if (!pending || !pending.at) return;
    if (Date.now() - Number(pending.at) > 45_000) {
      await chrome.storage.session.remove("pendingAppSubmitted");
      return;
    }
    // Pending written during Complete & Next for job A must not fire on job B.
    if (completeInFlight) {
      await chrome.storage.session.remove("pendingAppSubmitted");
      return;
    }
    if (lastAdvanceCompletedAt && Date.now() - lastAdvanceCompletedAt < ADVANCE_COOLDOWN_MS) {
      await chrome.storage.session.remove("pendingAppSubmitted");
      return;
    }
    await handleApplicationSubmitted(pending);
  } catch (err) {
    console.warn("consumePendingAppSubmitted failed", err);
  }
}

// ── confirm modal ────────────────────────────────────────────────────────────

function openConfirm(opts) {
  setState({ modal: { tone: "primary", confirmLabel: "Confirm", busy: false, ...opts } });
}

function closeModal() {
  if (state.modal && state.modal.busy) return;
  setState({ modal: null });
}

// Report the current job as expired/invalid: hides it from active lists, then
// advances to the next ready job (or Home). Opens a confirmation modal first.
function reportInvalidJob() {
  if (!state.job) return;
  openConfirm({
    title: "Report this job as expired?",
    message:
      "The posting link is no longer valid (the job has likely expired). It will be reported and removed from your active lists. This cannot be undone.",
    confirmLabel: "Report as expired",
    tone: "danger",
    onConfirm: confirmReportInvalid,
  });
}

async function confirmReportInvalid() {
  if (!state.job || !state.modal) return;
  const jobId = state.job.job_id;
  const reportedTitle = state.job.title || "(untitled job)";
  const reportedCompany = state.job.company || "";
  setState({ modal: { ...state.modal, busy: true } });
  try {
    await api.reportJobInvalid(jobId, "expired");
    await api.updateSession(jobId, "completed").catch(() => {});
    void removeCatalogJob(jobId);
  } catch (err) {
    setState({ modal: null, error: err.message });
    return;
  }
  await teardownAutofill();
  const notice = { reportedTitle, reportedCompany };
  setState({ modal: null, reportNotice: notice });
  try {
    const nx = await resolveNextJob(jobId);
    if (nx && nx.job_id) {
      if (state.applyListContext && Array.isArray(nx.nextJobIds)) {
        setState({
          applyListContext: {
            ...state.applyListContext,
            jobIds: nx.nextJobIds,
          },
        });
      }
      await openJob(nx.job_id, { redirect: true, keepReportNotice: true });
      return;
    }
  } catch {
    /* fall through to Home */
  }
  toast(
    `Reported as expired. No more jobs in this list (${listContextLabel(state.applyListContext)}).`
  );
  await goHome();
}

function dismissReportNotice() {
  if (state.reportNotice) setState({ reportNotice: null });
}

// ── autofill actions ─────────────────────────────────────────────────────────

async function startAutofill() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null || !/^https?:/i.test(tab.url || "")) {
      toast("Open the job application page in the active tab first.");
      return;
    }
    try {
      new URL(tab.url);
    } catch {
      toast("Cannot read the page URL.");
      return;
    }
    // Route to the platform's engine using the LIVE application page URL (more
    // reliable than the snapshot URL). A platform with a reserved-but-unbuilt
    // dedicated engine (e.g. Workday) is not filled by the generic engine.
    const engine = resolveEngine({ snapshot: state.job && state.job.snapshot, pageUrl: tab.url });
    if (!engine.available) {
      toast(`${engine.label} engine is not available yet. ${engine.note || "It will get its own dedicated engine."}`);
      return;
    }
    // Host permission for the page (and embedded ATS iframe when applicable).
    const permOrigins = autofillPermissionOrigins(tab.url, engine.platform);
    const granted = await chrome.permissions.request({ origins: permOrigins });
    if (!granted) {
      toast("Permission to read this page was denied.");
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: "AUTOFILL_INJECT", tabId: tab.id, engine: engine.scripts });
    if (!res || !res.ok) {
      toast("Could not start autofill on this page.");
      return;
    }
    // Deterministic engines (Workday) fill straight from the canonical profile -
    // no manual region selection, no LLM.
    if (engine.mode === "workday") {
      await startWorkdayAutofill(tab, engine);
      return;
    }
    // Auto-discovery engines (Greenhouse): select the page's single application
    // container and fill it automatically - no manual field tagging.
    if (engine.autoDiscover) {
      setState({ autofill: { ...emptyAutofill(), active: true, discovering: true, tabId: tab.id, engine } });
      try {
        await tabMsg.broadcastTabMessage(tab.id, { type: "AF_AUTOSELECT" });
        // Prefer the Greenhouse embed iframe when the career page is only a shell.
        const ghFrame = tabMsg.pickGreenhouseFrame(await tabMsg.getTabFrames(tab.id));
        if (ghFrame && ghFrame.frameId != null) {
          setAutofill({ primaryFrameId: ghFrame.frameId });
        }
      } catch {
        /* ignore */
      }
      // Fallback in case no frame reports back (e.g. the form is missing): wait
      // past the in-page discovery retry window, then either fill what we found
      // or surface an error.
      setTimeout(() => {
        if (!state.autofill.active || !state.autofill.discovering) return;
        if (state.autofill.fields.length) maybeAutoRun();
        else setAutofill({ discovering: false, error: "Could not find the application form on this page." });
      }, 3500);
      return;
    }
    await tabMsg.broadcastTabMessage(tab.id, { type: "AF_START" });
    setState({ autofill: { ...emptyAutofill(), active: true, picking: true, tabId: tab.id, engine } });
  } catch (err) {
    toast("Autofill could not start: " + ((err && err.message) || err));
  }
}

// Workday: fetch the canonical structured profile (respecting the user's
// original/tailored resume preference), optionally attach the generated resume
// file, and tell the in-page engine to fill the current step. Auto-advance is
// OFF - the user reviews and clicks Continue between steps.
async function startWorkdayAutofill(tab, engine) {
  const job = state.job;
  if (!job || !job.job_id) {
    toast("Open a job from your list first so we know which profile to use.");
    return;
  }
  setState({ autofill: { ...emptyAutofill(), active: true, running: true, tabId: tab.id, engine } });
  // Default to the tailored resume; only use the original when explicitly chosen.
  const resumeSource = (buildPreferences() || {}).resume_source === "original" ? "original" : "tailored";

  let profile;
  try {
    profile = await api.getAutofillProfile(job.job_id, resumeSource);
  } catch (err) {
    setAutofill({ running: false, done: true, error: "Could not load your profile: " + ((err && err.message) || err) });
    return;
  }

  // Best-effort resume attachment (skip silently if not generated for this job).
  let resumeFile = null;
  try {
    resumeFile = await api.downloadResumeFile(job.job_id, "resume_pdf");
    console.debug("[workday] resume PDF downloaded:", (resumeFile && resumeFile.filename) || "(unnamed)", "b64=", resumeFile && resumeFile.base64 && resumeFile.base64.length);
  } catch (e) {
    console.warn("[workday] resume PDF download failed:", (e && e.message) || e);
    resumeFile = null;
    toast((e && e.message) || "Could not download the tailored resume PDF for upload.");
  }

  // Auto-advance: drive the whole flow (fill → flush → recover → Save) until the
  // Review page. Otherwise fill just the current step and hand back to the user.
  if (state.autoAdvance) {
    setAutofill({ autoLoop: true, loopStop: false, loopFinished: null });
    await autoAdvanceWorkday(tab.id, profile, resumeFile);
    return;
  }

  try {
    const runSeq = ++wdRunSeq;
    await chrome.tabs.sendMessage(tab.id, {
      type: "WD_RUN",
      profile,
      options: { autoAdvance: false, resumeFile, newAttempt: true },
      runSeq,
    });
    armWorkdayWatchdog();
  } catch (err) {
    setAutofill({ running: false, done: true, error: "Could not reach the page: " + ((err && err.message) || err) });
  }
}

// ── Workday auto-advance loop ────────────────────────────────────────────────
// Owns the multi-step flow from the side panel because only this context can
// (a) focus the tab to flush the page's deferred text/date commits and (b) run
// the LLM recovery round-trip. Per step: fill → focus-flush → validate →
// (LLM recover + re-flush if needed) → Save & Continue. Stops at Review, when
// stuck, when errors persist after recovery, or when the user hits Stop.
const WD_MAX_STEPS = 9;
// Per step: hard cap on WD_RUN fill passes (initial + recoveries). Default 3 so a
// stuck My Information page cannot pile up 7 identical reports (old loop ran up
// to 1 initial + 3 attempts × 2 recoveries).
const WD_MAX_STEP_FILLS = 3;
// Per step: how many Save attempts after the initial fill.
const WD_MAX_SAVE_ATTEMPTS = 3;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function autofillFrameId() {
  const af = state.autofill;
  if (af && af.primaryFrameId != null) return af.primaryFrameId;
  for (const f of (af && af.fields) || []) {
    if (f.frameId != null && (f.controlCount || 0) > 0) return f.frameId;
  }
  return null;
}

function tabSend(tabId, msg, frameId) {
  const fid = frameId != null ? frameId : autofillFrameId();
  if (fid != null) return tabMsg.sendTabMessage(tabId, msg, fid);
  return tabMsg.sendTabMessage(tabId, msg, 0);
}

function tabBroadcast(tabId, msg) {
  return tabMsg.broadcastTabMessage(tabId, msg);
}

// Wait for the page to finish a WD_RUN fill (resolved via the WD_DONE handler).
// The My Experience step can be slow (panel adds wait ~20s each + LLM matches),
// so allow generous headroom before giving up.
function waitWorkdayFill(timeoutMs = 180000) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      wdStepWaiter = null;
      resolve({ timeout: true });
    }, timeoutMs);
    wdStepWaiter = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      wdStepWaiter = null;
      resolve(payload || {});
    };
  });
}

// Give the application tab real OS focus so the page's window 'focus' fires and
// flushes deferred commits, then ask the engine to flush as an explicit backstop.
async function focusPageAndFlush(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    /* tab/window may be gone */
  }
  await delay(450); // let the focus event settle (may still be false with side panel open)
  const flush = await tabSend(tabId, { type: "WD_FLUSH" }, 0);
  try {
    console.debug("[workday] focusPageAndFlush:", flush);
  } catch {}
  await delay(150);
}

async function fillCurrentStep(tabId, profile, resumeFile, extraOptions) {
  if (state.autofill.loopStop || !state.autofill.active) return { aborted: true };
  const runSeq = ++wdRunSeq;
  const wait = waitWorkdayFill();
  const options = { autoAdvance: false, resumeFile, ...(extraOptions || {}) };
  try {
    await tabSend(tabId, { type: "WD_RUN", profile, options, runSeq }, 0);
  } catch (err) {
    if (wdStepWaiter) wdStepWaiter({ error: (err && err.message) || String(err) });
  }
  // Stop may have resolved the waiter while tabSend was in flight.
  if (state.autofill.loopStop) {
    void tabBroadcast(tabId, { type: "WD_ABORT", minRunSeq: wdRunSeq });
  }
  return wait;
}

function workdayReallyAdvanced(fromStep, next) {
  if (!next || !next.advanced || (next && next.aborted)) return false;
  const after = next.after;
  if (!after || after === fromStep || after === "generic") return false;
  return true;
}

async function autoAdvanceWorkday(tabId, profile, resumeFile) {
  const loopStopped = () => state.autofill.loopStop || !state.autofill.active;
  // First WD_RUN of this session clears the failed-field skip set; recoveries keep it.
  let sessionFresh = true;
  try {
    for (let i = 0; i < WD_MAX_STEPS; i++) {
      if (loopStopped()) return finishLoop("stopped");

      const det = await tabSend(tabId, { type: "WD_DETECT" }, 0);
      const step = det && det.step;
      if (step === "submitted") {
        finishLoop("submitted");
        await handleApplicationSubmitted({
          reason: "wd-detect-submitted",
          jobId: state.job && state.job.job_id,
        });
        return;
      }
      if (!step) return finishLoop(state.autofill.reports.length ? "done" : "none");
      if (step === "review") return finishLoop("review");

      const label = WD_STEP_LABELS[step] || step;
      let fillsUsed = 0;
      const runFill = async (extraOptions) => {
        if (loopStopped()) return { aborted: true };
        if (fillsUsed >= WD_MAX_STEP_FILLS) return { skipped: true };
        fillsUsed += 1;
        const opts = { ...(extraOptions || {}), newAttempt: sessionFresh };
        sessionFresh = false;
        return fillCurrentStep(tabId, profile, resumeFile, opts);
      };

      // Initial fill of the step.
      setAutofill({ loopStatus: `Filling ${label}…` });
      const fill = await runFill();
      if (fill.aborted || loopStopped()) return finishLoop("stopped");
      if (fill.error) return finishLoop("error", fill.error);

      // Clear validation and advance. CRITICAL: Workday surfaces most required-
      // field errors only AFTER clicking "Save and Continue", so a clean pre-save
      // check is not enough. Cap fills at WD_MAX_STEP_FILLS (default 3) so recovery
      // cannot re-drive the same prompts indefinitely.
      let advanced = false;
      let lastNames = [];
      for (let attempt = 0; attempt < WD_MAX_SAVE_ATTEMPTS && !advanced; attempt++) {
        if (loopStopped()) return finishLoop("stopped");
        setAutofill({ loopStatus: `Committing ${label}…` });
        await focusPageAndFlush(tabId);
        if (loopStopped()) return finishLoop("stopped");

        // Fix anything already flagged before saving (if we still have fill budget).
        let v = await tabSend(tabId, { type: "WD_VALIDATE" }, 0);
        if (v && !v.clean && fillsUsed < WD_MAX_STEP_FILLS) {
          lastNames = (v.invalidFields || []).map((f) => f.label || f.key).filter(Boolean);
          console.debug(`[workday] auto-advance: ${label} pre-save errors`, v.invalidFields);
          setAutofill({ loopStatus: `Resolving ${v.errorCount || ""} issue(s) on ${label}…` });
          const rec = await runFill({ onlyInvalid: v.invalidFields });
          if (rec.aborted || loopStopped()) return finishLoop("stopped");
          if (rec.error) return finishLoop("error", rec.error);
          await focusPageAndFlush(tabId);
          if (loopStopped()) return finishLoop("stopped");
        }

        // Try to advance.
        setAutofill({ loopStatus: `Advancing from ${label}…` });
        const next = await tabSend(tabId, { type: "WD_NEXT" }, 0);
        if (loopStopped() || (next && next.aborted)) return finishLoop("stopped");
        if (workdayReallyAdvanced(step, next)) {
          // Re-detect: reject false positives from transient detectStep flips.
          const confirm = await tabSend(tabId, { type: "WD_DETECT" }, 0);
          if (confirm && confirm.step && confirm.step !== step && confirm.step !== "generic") {
            advanced = true;
            break;
          }
          console.debug(`[workday] auto-advance: ${label} false advance ignored`, next, confirm);
        }

        // Didn't advance - re-validate; Workday likely just revealed errors on Save.
        await focusPageAndFlush(tabId);
        if (loopStopped()) return finishLoop("stopped");
        v = await tabSend(tabId, { type: "WD_VALIDATE" }, 0);
        if (v && !v.clean) {
          lastNames = (v.invalidFields || []).map((f) => f.label || f.key).filter(Boolean);
          console.debug(`[workday] auto-advance: ${label} post-save errors`, v.invalidFields);
          if (fillsUsed < WD_MAX_STEP_FILLS) {
            setAutofill({ loopStatus: `Resolving ${v.errorCount || ""} issue(s) on ${label}…` });
            const rec = await runFill({ onlyInvalid: v.invalidFields });
            if (rec.aborted || loopStopped()) return finishLoop("stopped");
            if (rec.error) return finishLoop("error", rec.error);
            // next save attempt uses the freshly filled values
          }
        } else {
          // No detectable error but it didn't move - maybe a slow navigation.
          await delay(1600);
          if (loopStopped()) return finishLoop("stopped");
          const d2 = await tabSend(tabId, { type: "WD_DETECT" }, 0);
          if (d2 && d2.step && d2.step !== step && d2.step !== "generic") {
            advanced = true;
            break;
          }
          console.debug(`[workday] auto-advance: ${label} did not advance and no errors detected (attempt ${attempt + 1})`);
        }
      }

      if (loopStopped()) return finishLoop("stopped");
      if (!advanced) {
        // Post-submit confirmation can look like a dead-end step; Complete & Next.
        const recheck = await tabSend(tabId, { type: "WD_DETECT" }, 0);
        if (recheck && recheck.step === "submitted") {
          finishLoop("submitted");
          await handleApplicationSubmitted({
            reason: "wd-stuck-submitted",
            jobId: state.job && state.job.job_id,
          });
          return;
        }
        if (recheck && recheck.step === "review") return finishLoop("review");
        return finishLoop(
          "needs_user",
          lastNames.length ? `Couldn't resolve on ${label}: ${lastNames.join(", ")}` : `Couldn't advance past ${label} (no fixable errors detected).`
        );
      }
      const afterStep = await tabSend(tabId, { type: "WD_DETECT" }, 0);
      if (afterStep && afterStep.step === "submitted") {
        finishLoop("submitted");
        await handleApplicationSubmitted({
          reason: "wd-after-advance-submitted",
          jobId: state.job && state.job.job_id,
        });
        return;
      }
      if (afterStep && afterStep.step === "review") return finishLoop("review");
      await delay(600);
    }
    return finishLoop("guard");
  } catch (err) {
    if (loopStopped()) return finishLoop("stopped");
    return finishLoop("error", (err && err.message) || String(err));
  }
}

function finishLoop(reason, error) {
  const messages = {
    review: "Reached the Review step - review and submit when you're ready.",
    submitted: "Application submitted — loading next job…",
    done: "Finished the available steps.",
    none: "No Workday application step was detected on this page.",
    stopped: "Auto-advance stopped.",
    stuck: error || "Stopped: could not advance.",
    needs_user: error || "Stopped: some fields need your input.",
    guard: "Stopped after the maximum number of steps.",
    error: error || "Autofill failed.",
  };
  setAutofill({
    running: false,
    done: true,
    autoLoop: true,
    loopStatus: null,
    loopFinished: reason,
    error: reason === "error" ? error || "Autofill failed." : null,
    loopMessage: messages[reason] || "Done.",
  });
}

/** Immediate stop: invalidate runSeq, abort the page engine, unblock the waiter. */
function stopWorkdayAutofill() {
  wdRunSeq += 1;
  setAutofill({ loopStop: true, loopStatus: "Stopping…" });
  const tabId = state.autofill && state.autofill.tabId;
  if (tabId != null) {
    try {
      void tabBroadcast(tabId, { type: "WD_ABORT", minRunSeq: wdRunSeq });
    } catch {
      /* tab may be gone */
    }
  }
  if (wdStepWaiter) {
    try {
      wdStepWaiter({ aborted: true });
    } catch {
      /* ignore */
    }
  }
  // Single-step (non-loop) runs have no autoAdvanceWorkday to call finishLoop.
  if (state.autofill && state.autofill.running && !state.autofill.autoLoop) {
    setAutofill({
      running: false,
      done: true,
      loopFinished: "stopped",
      loopMessage: "Autofill stopped.",
      loopStatus: null,
    });
  }
}

function stopAutoAdvance() {
  stopWorkdayAutofill();
}

// If no frame contains a Workday step, none reply - surface that after a wait.
function armWorkdayWatchdog() {
  setTimeout(() => {
    const a = state.autofill;
    if (a.active && a.running && a.engine && a.engine.mode === "workday" && !a.reports.length) {
      setAutofill({ running: false, done: true });
    }
  }, 9000);
}

async function teardownAutofill() {
  const af = state.autofill;
  if (af && af.tabId != null) {
    try {
      wdRunSeq += 1;
      await tabBroadcast(af.tabId, { type: "WD_ABORT", minRunSeq: wdRunSeq });
    } catch {
      /* tab may be gone */
    }
    try {
      await tabBroadcast(af.tabId, { type: "AF_CLEAR" });
    } catch {
      /* tab may be gone */
    }
  }
  if (wdStepWaiter) {
    try {
      wdStepWaiter({ aborted: true });
    } catch {
      /* ignore */
    }
  }
  state.autofill = emptyAutofill();
}

async function cancelAutofill() {
  await teardownAutofill();
  setState({});
}

async function removeAutofillField(handle) {
  const tabId = state.autofill.tabId;
  if (tabId != null) {
    try {
      const field = state.autofill.fields.find((f) => f.handle === handle);
      await tabSend(tabId, { type: "AF_REMOVE", handle }, field && field.frameId != null ? field.frameId : undefined);
    } catch {
      /* ignore */
    }
  }
  setAutofill({ fields: state.autofill.fields.filter((f) => f.handle !== handle) });
}

async function resumePicking() {
  const tabId = state.autofill.tabId;
  if (tabId == null) return;
  try {
    await tabBroadcast(tabId, { type: "AF_START" });
  } catch {
    /* ignore */
  }
  setAutofill({ picking: true });
}

// Greenhouse "Discipline" is a fixed-taxonomy dropdown that rarely contains a
// candidate's actual discipline, so (mirroring the Workday standard field-of-
// study) we always set it to one standard value rather than deriving it.
const GREENHOUSE_DEFAULT_DISCIPLINE = "Computer Science";

// Greenhouse: add a repeating education row per profile entry (Workday-style)
// and fill School/Degree/Discipline DETERMINISTICALLY, one control at a time,
// BEFORE the generic fill. Doing it per-row avoids the generic harvest opening
// every education dropdown at once (which stacks the menus open and leaves
// School/Degree unselected). Filled controls then report filled, so the LLM
// pass skips them. Best-effort: a fetch failure just fills Discipline on the
// existing row(s).
async function prepareGreenhouseEducation(tabId) {
  if (!state.job || !state.job.job_id || tabId == null) return;
  const resumeSource = (buildPreferences() || {}).resume_source === "original" ? "original" : "tailored";
  let entries = [];
  try {
    const profile = await api.getAutofillProfile(state.job.job_id, resumeSource);
    if (Array.isArray(profile.education)) {
      entries = profile.education.map((e) => ({
        school: (e && (e.school || e.university_name)) || "",
        degree: (e && e.degree) || "",
      }));
    }
  } catch {
    entries = [];
  }
  await tabSend(tabId, {
    type: "AF_GH_PREP",
    entries,
    discipline: GREENHOUSE_DEFAULT_DISCIPLINE,
  });
  // Let newly mounted rows / committed selections settle before extraction.
  await delay(1200);
}

// ApplyToJob (JazzHR): reveal the hidden resume file input before extraction so
// the engine claims it and the file driver can attach the resume PDF. Mirrors
// the Greenhouse education prep.
async function prepareApplyToJob(tabId) {
  if (tabId == null) return;
  await tabSend(tabId, { type: "AF_ATJ_PREP" });
  await delay(400);
}

// Manatal (careers-page.com): tick the required terms/privacy consent checkbox
// before extraction so it is already filled for the LLM pass.
async function prepareManatal(tabId) {
  if (tabId == null) return;
  await tabSend(tabId, { type: "AF_MANATAL_PREP" });
  await delay(200);
}

// ── iCIMS ────────────────────────────────────────────────────────────────────

// A password satisfying the rule iCIMS states in the field's own title
// attribute: "Minimum 8 characters, 1 alphabetic, 1 lowercase, 1 uppercase,
// 1 numeric, 1 special character(s)". Ambiguous glyphs (l/1/O/0) are left out so
// the candidate can retype it from the panel without misreading it.
function generatePortalPassword() {
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const special = "!@#$%^&*";
  const all = lower + upper + digits + special;
  const bytes = new Uint32Array(20);
  crypto.getRandomValues(bytes);
  const chars = [
    upper[bytes[0] % upper.length],
    lower[bytes[1] % lower.length],
    digits[bytes[2] % digits.length],
    special[bytes[3] % special.length],
  ];
  for (let i = 4; i < 16; i++) chars.push(all[bytes[i] % all.length]);
  // Shuffle so the four guaranteed classes are not always in the same slots.
  const swap = new Uint32Array(chars.length);
  crypto.getRandomValues(swap);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = swap[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

async function tabHost(tabId) {
  if (tabId == null) return "";
  try {
    const tab = await chrome.tabs.get(tabId);
    return new URL(tab.url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Re-inject the engine bundle after the page navigated under us (iCIMS submits
// the form to upload a resume, which destroys every content script).
async function reinjectEngine(tabId, eng) {
  if (tabId == null) return false;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "AUTOFILL_INJECT",
      tabId,
      engine: (eng && eng.scripts) || "greenhouse",
    });
    return !!(res && res.ok);
  } catch {
    return false;
  }
}

// Ask every frame whether it hosts the iCIMS resume field; the one that does
// answers with { present, attached, parsing, needsCredentials }.
async function icimsResumeState(tabId) {
  if (tabId == null) return null;
  let replies = [];
  try {
    replies = await tabBroadcast(tabId, { type: "AF_ICIMS_RESUME_STATE" });
  } catch {
    return null;
  }
  for (const r of replies || []) {
    if (r && r.ok && r.present) return r;
  }
  return null;
}

// iCIMS uploads the resume FIRST, not last.
//
// The resume input's own onchange runs
//   this.form.action = this.form.action + '&uploadResume=1'; this.form.submit();
// and the page states "Existing data in the form will be replaced". So the
// upload navigates the tab and iCIMS re-renders the whole profile server-side,
// pre-filled from the parsed resume (the fields carrying bgtparse="true").
// Anything written beforehand is destroyed, which is why this runs before the
// very first extraction instead of after the last write like Lever/Ashby.
//
// Returns true when the caller must re-discover the form (the page reloaded).
async function uploadIcimsResumeFirst(tabId, eng, ctx) {
  if (tabId == null || !state.job || !state.job.job_id) return false;
  const before = await icimsResumeState(tabId);
  if (!before) return false; // this step has no resume field (later application step)
  if (before.attached) return false; // already uploaded on an earlier run

  setAutofill({ runStatus: "Uploading your resume…" });
  const cache = {};
  const file = await fetchRoleFile(state.job.job_id, "resume", "", cache);
  if (!file) {
    ctx.needsUser.push({
      cid: "icims-resume",
      label: "Resume",
      reason:
        "Upload it yourself before filling anything else - no generated resume exists for this job, and iCIMS reloads the page and replaces the form when a resume is attached.",
    });
    return false;
  }

  try {
    // Broadcast: the upload navigates the page, so the reply usually never
    // arrives. A dead message channel here is the expected outcome, not a error.
    await tabBroadcast(tabId, { type: "AF_ICIMS_UPLOAD_RESUME", file });
  } catch {
    /* page is navigating */
  }

  setAutofill({ runStatus: "Waiting for iCIMS to parse your resume…" });
  setAutofill({ primaryFrameId: null });
  await delay(1500);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await reinjectEngine(tabId, eng);
    const st = await icimsResumeState(tabId);
    if (st && st.attached && !st.parsing) return true;
    await delay(1200);
  }
  // The reload never settled. Re-discovering is still the right move: the page
  // may be mid-render and the old handles are detached either way.
  console.warn("[autofill] iCIMS resume upload did not confirm within 45s");
  return true;
}

// Ask every frame where this iCIMS page sits in the application itinerary.
// Only the frame hosting the form answers (portals can be iframed).
async function icimsStage(tabId) {
  if (tabId == null) return null;
  let replies = [];
  try {
    replies = await tabBroadcast(tabId, { type: "AF_ICIMS_STAGE" });
  } catch {
    return null;
  }
  let best = null;
  let bestScore = -1;
  for (const r of replies || []) {
    if (!r || !r.ok || !r.icims) continue;
    // The frame hosting the live step has both the itinerary and an advance
    // button; prefer it over portal chrome that happens to carry only one.
    const score = (r.hasSubmit ? 2 : 0) + (r.stepsPresent ? 1 : 0);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

// Advance one iCIMS step: click the step's Submit, ride out the full-document
// navigation, re-inject the engine into the new page and confirm we actually
// moved. Unlike SmartRecruiters/Breezy (SPAs that re-render in place), every
// iCIMS step is a real POST that destroys every content script - so "did it
// work?" can only be answered by the freshly injected script on the next page,
// exactly the way uploadIcimsResumeFirst rides out the resume upload.
//
// Returns { advanced, stage, errors }.
async function icimsAdvance(tabId, eng, fromStage) {
  const before = fromStage || (await icimsStage(tabId));
  if (!before || !before.hasSubmit) return { advanced: false, stage: before, errors: [] };

  try {
    // The click navigates, so the reply is expected to be lost, not an error.
    await tabBroadcast(tabId, { type: "AF_ICIMS_SUBMIT" });
  } catch {
    /* page is navigating */
  }

  // Handles from the old document are dead and frame ids change on reload.
  setAutofill({ fields: [], primaryFrameId: null });
  await delay(1200);

  const deadline = Date.now() + 45000;
  let last = null;
  while (Date.now() < deadline) {
    await reinjectEngine(tabId, eng);
    const st = await icimsStage(tabId);
    if (st) {
      last = st;
      // Moving to a later step is the only proof the POST was accepted; a step
      // that re-renders in place was rejected and now carries the reasons.
      if (before.step && st.step && st.step > before.step) return { advanced: true, stage: st, errors: [] };
      if (st.errors && st.errors.length) return { advanced: false, stage: st, errors: st.errors };
      // No step indicator to compare: fall back to the page's own identity.
      if (!before.step && st.heading && st.heading !== before.heading) {
        return { advanced: true, stage: st, errors: [] };
      }
    }
    await delay(1200);
  }
  return {
    advanced: false,
    stage: last,
    errors: (last && last.errors) || [],
    timedOut: true,
  };
}

// iCIMS pre-pass, run after the resume upload and before extraction. Two field
// groups are written deterministically from the profile because the model
// provably cannot answer them correctly (see content/engine/icims.js):
//
//  * the phone block - Number is autocomplete="tel-national" and iCIMS' own
//    resume parser pre-fills it with the full international string, which reads
//    as "filled" so the generic pass never corrects it; Phone Country Code is a
//    searchable AJAX dropdown offered with no options, which the backend then
//    answers with a bare dial code that matches nothing in the list.
//  * the "Create a login" block - the two password boxes must hold the SAME
//    value and satisfy the complexity rule in their own title attribute.
//
// Both need the canonical autofill profile, so it is fetched once here.
async function prepareIcims(tabId, ctx) {
  if (tabId == null) return;
  const host = await tabHost(tabId);
  if (!host) return;
  const userId = state.user && state.user.user_id;

  // A multi-step application runs this prep once per step; the profile is the
  // same every time, so fetch it once per run and reuse it across the steps.
  let profile = null;
  if (ctx && "icimsProfile" in ctx) {
    profile = ctx.icimsProfile;
  } else if (state.job && state.job.job_id) {
    const resumeSource = (buildPreferences() || {}).resume_source === "original" ? "original" : "tailored";
    try {
      profile = await api.getAutofillProfile(state.job.job_id, resumeSource);
    } catch {
      profile = null;
    }
    if (ctx) ctx.icimsProfile = profile;
  }
  const contact = (profile && profile.contact) || {};
  const address = (profile && profile.address) || {};

  try {
    const phoneRes = await tabSend(tabId, {
      type: "AF_ICIMS_PHONE",
      phone: contact.phone || "",
      countryCode: contact.phoneCountryCode || "",
      country: address.country || "",
    });
    if (phoneRes && phoneRes.ok) {
      console.log("[autofill] iCIMS phone prep:", phoneRes);
      // The dial-code dropdown is required; if neither the profile nor the
      // widget search could resolve it, iCIMS rejects the whole phone block on
      // submit, so say so instead of letting it fail silently.
      if (phoneRes.codePresent && !phoneRes.code) {
        ctx.needsUser.push({
          cid: "icims-phone-country-code",
          label: "Phones - Phone Country Code",
          reason: "Pick your dialing code - iCIMS rejects the phone block without it.",
        });
      }
    }
  } catch {
    /* no phone block on this page */
  }
  await delay(200);

  // The login is the candidate's email (the field is autocomplete="username"),
  // so it matches the Email field the LLM pass writes.
  let login = contact.email || "";
  if (!login) {
    const cached = state.cache && state.cache.profile;
    login = (cached && cached.email) || (state.user && state.user.email) || "";
  }

  let creds = null;
  try {
    creds = await store.getAtsCredential(userId, host);
  } catch {
    creds = null;
  }
  if (!creds) {
    creds = { login, password: generatePortalPassword() };
  } else if (login && !creds.login) {
    creds = { ...creds, login };
  }

  let res = null;
  try {
    res = await tabSend(tabId, { type: "AF_ICIMS_CREDENTIALS", login: creds.login, password: creds.password });
  } catch {
    res = null;
  }
  await delay(200);
  // Nothing written means this page has no "Create a login" block (or the
  // candidate is already signed in), so there is no account to remember.
  if (!res || !res.ok || !(res.login || res.password)) return;

  try {
    await store.saveAtsCredential(userId, host, creds);
  } catch {
    /* storage is best-effort; the password is still shown below */
  }
  if (!ctx.needsUser.some((x) => x.cid === "icims-credentials")) {
    ctx.needsUser.push({
      cid: "icims-credentials",
      label: `${host} account password`,
      reason: `Save this in your password manager - iCIMS created an account for you. Login: ${creds.login || "(see the form)"} / Password: ${creds.password}`,
    });
  }
}

// RecruiterFlow: add a repeating Experience/Education row per profile entry
// (Workday-style) and fill Company/Title/School/Degree/dates + Country
// deterministically, and tick the required consent box, BEFORE the generic fill.
// Filled controls then report filled, so the LLM pass skips them. Best-effort:
// a fetch failure just lets the generic pass handle whatever it can.
async function prepareRecruiterFlow(tabId) {
  if (!state.job || !state.job.job_id || tabId == null) return;
  const resumeSource = (buildPreferences() || {}).resume_source === "original" ? "original" : "tailored";
  let experience = [];
  let education = [];
  let country = "";
  try {
    const profile = await api.getAutofillProfile(state.job.job_id, resumeSource);
    if (Array.isArray(profile.workExperience)) {
      experience = profile.workExperience.map((w) => ({
        company: (w && w.company) || "",
        title: (w && w.title) || "",
        start: (w && w.startMMYYYY) || "",
        end: (w && w.endMMYYYY) || "",
        current: !!(w && w.current),
      }));
    }
    if (Array.isArray(profile.education)) {
      education = profile.education.map((e) => ({
        school: (e && (e.school || e.university_name)) || "",
        degree: (e && e.degree) || "",
        start: (e && e.startMMYYYY) || "",
        end: (e && e.endMMYYYY) || "",
      }));
    }
    country = (profile && profile.address && profile.address.country) || "";
  } catch {
    experience = [];
    education = [];
    country = "";
  }
  await tabSend(tabId, { type: "AF_RF_PREP", experience, education, country });
  // Let newly mounted rows / committed selections settle before extraction.
  await delay(500);
}

// SmartRecruiters: add + Save a repeating Experience/Education entry per profile
// entry (Workday-style: Add -> fill -> Save) and tick the required consent box,
// BEFORE the generic fill. The repeating subtrees are excluded from generic
// detection, so the prep owns them; personal info / resume are left to the LLM
// pass. Best-effort: a fetch failure just lets the generic pass handle the rest.
async function prepareSmartRecruiters(tabId) {
  if (!state.job || !state.job.job_id || tabId == null) return;
  const resumeSource = (buildPreferences() || {}).resume_source === "original" ? "original" : "tailored";
  let experience = [];
  let education = [];
  let home = null;
  try {
    const profile = await api.getAutofillProfile(state.job.job_id, resumeSource);
    const addr = (profile && profile.address) || {};
    home = {
      city: addr.city || "",
      state: addr.state || "",
      country: addr.country || "",
      postalCode: addr.postalCode || addr.postal_code || "",
    };
    if (Array.isArray(profile.workExperience)) {
      experience = profile.workExperience.map((w) => ({
        company: (w && w.company) || "",
        title: (w && w.title) || "",
        location: (w && w.location) || "",
        description: (w && w.description) || "",
        start: (w && w.startMMYYYY) || "",
        end: (w && w.endMMYYYY) || "",
        current: !!(w && w.current),
      }));
    }
    if (Array.isArray(profile.education)) {
      education = profile.education.map((e) => ({
        school: (e && (e.school || e.university_name)) || "",
        degree: (e && e.degree) || "",
        major: (e && e.fieldOfStudy) || "",
        description: (e && e.description) || "",
        start: (e && e.startMMYYYY) || "",
        end: (e && e.endMMYYYY) || "",
      }));
    }
  } catch {
    experience = [];
    education = [];
  }
  await tabSend(tabId, { type: "AF_SR_PREP", experience, education, home });
  // Repeating rows mount + save asynchronously; let the form settle before extract.
  await delay(600);
}

// Workable: add + Update a repeating Education/Experience entry per profile
// entry BEFORE the generic fill. Repeating subtrees are excluded from generic
// detection; personal info / summary / cover letter go to the LLM pass.
async function prepareWorkable(tabId) {
  if (!state.job || !state.job.job_id || tabId == null) return;
  const resumeSource = (buildPreferences() || {}).resume_source === "original" ? "original" : "tailored";
  let experience = [];
  let education = [];
  try {
    const profile = await api.getAutofillProfile(state.job.job_id, resumeSource);
    if (Array.isArray(profile.workExperience)) {
      experience = profile.workExperience.map((w) => ({
        company: (w && w.company) || "",
        title: (w && w.title) || "",
        industry: (w && w.industry) || "",
        description: (w && w.description) || "",
        start: (w && w.startMMYYYY) || "",
        end: (w && w.endMMYYYY) || "",
        current: !!(w && w.current),
      }));
    }
    if (Array.isArray(profile.education)) {
      education = profile.education.map((e) => ({
        school: (e && (e.school || e.university_name)) || "",
        degree: (e && e.degree) || "",
        field_of_study: (e && e.fieldOfStudy) || "",
        start: (e && e.startMMYYYY) || "",
        end: (e && e.endMMYYYY) || "",
      }));
    }
  } catch {
    experience = [];
    education = [];
  }
  await tabSend(tabId, { type: "AF_WB_PREP", experience, education });
  await delay(600);
}

// Fill a cover-letter textarea with the AI-generated cover letter body (the same
// text used to build the cover letter DOCX), so platforms that take a pasted
// cover letter get it verbatim instead of an LLM re-write. No-op when no cover
// letter was generated for this job. Runs before extraction so the filled
// textarea reports filled and the LLM pass skips it.
async function prepareCoverLetter(tabId) {
  if (!state.job || !state.job.job_id || tabId == null) return;
  const resumeSource = (buildPreferences() || {}).resume_source === "original" ? "original" : "tailored";
  let text = "";
  try {
    const profile = await api.getAutofillProfile(state.job.job_id, resumeSource);
    text = (profile && profile.coverLetter) || "";
  } catch {
    text = "";
  }
  if (!text) return;
  await tabSend(tabId, { type: "AF_FILL_COVER_LETTER", text });
  await delay(200);
}

// Classify a field label into a stable identity / EEO / work-authorization /
// consent category, or null if it isn't one we remember. MUST stay identical to
// the copy in content/picker.js so cached keys line up. Order matters (work_auth
// keywords overlap citizenship).
function answerCategory(label) {
  const s = (label || "").toLowerCase();
  if (!s) return null;
  if (/\bgender\b|\bsex\b/.test(s)) return "gender";
  if (/hispanic|latino|latina|latinx/.test(s)) return "hispanic";
  if (/\brace\b|ethnic|nationalit/.test(s)) return "race";
  if (/veteran/.test(s)) return "veteran";
  if (/disab/.test(s)) return "disability";
  if (/sponsor/.test(s)) return "sponsorship";
  if (/citizen|authoriz|eligible to work|right to work|legally authorized/.test(s)) return "work_auth";
  if (/how did you hear|hear about (us|this|the)/.test(s)) return "how_hear";
  if (/\bconsent\b|acknowledg|i agree|\bterms\b|privacy/.test(s)) return "consent";
  return null;
}

// Select engines: replay remembered identity answers (EEO, work authorization,
// consent) BEFORE extraction. The page fills any control whose category we've
// cached, marking it filled, so the harvest + LLM pass skips it - no menu
// opening and no LLM round-trip for questions whose answer never changes.
// The cache is scoped to the engine's platform: option text learned on one ATS
// is never replayed on another (their option phrasing / value maps differ), so
// a new platform fills everything via the LLM until it builds its own cache.
async function prepareCachedAnswers(tabId, platform) {
  if (tabId == null) return;
  const userId = state.user && state.user.user_id;
  let pairs = {};
  try {
    pairs = await store.getAnswerCache(userId, platform);
  } catch {
    pairs = {};
  }
  if (!pairs || !Object.keys(pairs).length) return;
  await tabSend(tabId, { type: "AF_APPLY_CACHE", pairs });
  await delay(400);
}

// Commit browser-autofilled values into the page's framework (React) state so a
// controlled form counts them as filled. Best-effort and side-effect-free on the
// visible text (it re-fires each input's own value), so it's safe for any engine.
async function commitPrefilled(tabId) {
  if (tabId == null) return;
  try {
    await tabSend(tabId, { type: "AF_COMMIT_PREFILLED" });
    await delay(150);
  } catch {
    /* ignore */
  }
}

// Auto-discovery: once the application container is registered, leave the
// discovering state and start filling. Guarded by the discovering flag so it
// fires exactly once even if several frames report back.
function maybeAutoRun() {
  const af = state.autofill;
  if (!af.active || !af.discovering || af.running || !af.fields.length) return;
  setAutofill({ discovering: false });
  runAutofill();
}

function buildPreferences() {
  const s = (state.cache && state.cache.settings) || {};
  const prefs = {};
  const localStrat = (state.answerStrategy || "").trim();
  const strat =
    localStrat ||
    s.application_answer_strategy ||
    s.autofill_answer_strategy ||
    s.answer_strategy;
  if (strat) prefs.answer_strategy = String(strat);
  const localSrc = state.resumeSource === "original" ? "original" : "tailored";
  const src = localSrc || s.application_resume_source || s.resume_source;
  if (src) prefs.resume_source = String(src);
  return Object.keys(prefs).length ? prefs : undefined;
}

// Ask the content script(s) to extract structured specs for the selected blocks.
function extractTimeoutMs(handles) {
  const fields = state.autofill.fields || [];
  let controls = 0;
  for (const f of fields) {
    if (!handles.length || handles.includes(f.handle)) controls += f.controlCount || 0;
  }
  // Each unfilled react-select harvest opens/closes a menu (~300–800ms). A 42-control
  // Greenhouse embed easily exceeds the old 4s cap; scale with control count.
  return Math.min(120000, Math.max(20000, 6000 + controls * 450));
}

function extractSpecs(tabId, handles) {
  return new Promise((resolve) => {
    const collected = new Map();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      extractCollector = null;
      resolve([...collected.values()]);
    };
    extractCollector = { expected: new Set(handles), collected, finish };
    const frameId = autofillFrameId();
    const timeoutMs = extractTimeoutMs(handles);
    if (tabId != null) {
      try {
        if (frameId != null) tabSend(tabId, { type: "AF_EXTRACT", handles }, frameId);
        else tabBroadcast(tabId, { type: "AF_EXTRACT", handles });
      } catch {
        /* ignore */
      }
    }
    setTimeout(finish, timeoutMs);
  });
}

function looksLikeResumeOrCoverLabel(label) {
  const t = String(label || "").toLowerCase();
  if (!t) return false;
  if (/\bcover\s*letter\b/.test(t)) return true;
  return /\b(resume|cv|curriculum\s*vitae)\b/.test(t);
}

function inferFileRoleFromLabel(label) {
  const t = String(label || "").toLowerCase();
  if (/\bcover\s*letter\b/.test(t)) return "cover_letter";
  if (/\b(resume|cv|curriculum\s*vitae)\b/.test(t)) return "resume";
  return null;
}

/** Ensure file controls get resume/cover_letter roles from their labels when the model omits them. */
function normalizeFileRolesInResults(results, specs) {
  const labelByCid = {};
  const fileCids = new Set();
  for (const f of specs || []) {
    for (const c of f.controls || []) {
      if (!c || !c.is_file) continue;
      fileCids.add(c.cid);
      labelByCid[c.cid] = c.label || f.label || "";
    }
  }
  for (const r of results || []) {
    for (const c of r.controls || []) {
      if (!fileCids.has(c.cid)) continue;
      const role = String(c.file_role || "").toLowerCase();
      if (role === "resume" || role === "cover_letter") continue;
      const inferred = inferFileRoleFromLabel(labelByCid[c.cid]);
      if (inferred) c.file_role = inferred;
    }
  }
}

// Fetch a generated file for a role, preferring PDF (or whatever the field
// accepts), falling back to DOCX. Cached per file type. Returns null if neither
// exists (e.g. the cover letter was never built for this job).
async function fetchRoleFile(jobId, role, accept, cache) {
  const acc = (accept || "").toLowerCase();
  const wantsDocxFirst = acc && !acc.includes("pdf") && (acc.includes("doc") || acc.includes("word"));
  const order = wantsDocxFirst
    ? [`${role}_docx`, `${role}_pdf`]
    : [`${role}_pdf`, `${role}_docx`];
  let lastErr = null;
  for (const fileType of order) {
    if (fileType in cache) {
      if (cache[fileType]) return cache[fileType];
      continue;
    }
    try {
      cache[fileType] = await api.downloadResumeFile(jobId, fileType);
      return cache[fileType];
    } catch (err) {
      lastErr = err;
      cache[fileType] = null;
      try {
        console.warn(`[autofill] download ${fileType} failed:`, (err && err.message) || err);
      } catch {}
    }
  }
  if (lastErr) cache.__lastError = lastErr;
  return null;
}

// Build a cid -> file map for file controls. Returns { files, missing } where
// missing lists file controls whose role file does not exist on the server.
async function fetchFilesForResults(jobId, results, specs) {
  const acceptByCid = {};
  const fileCids = new Set();
  for (const f of specs) {
    for (const c of f.controls || []) {
      if (c.is_file) {
        fileCids.add(c.cid);
        acceptByCid[c.cid] = c.accept || "";
      }
    }
  }
  const files = {};
  const missing = [];
  const cache = {};
  for (const r of results) {
    for (const c of r.controls || []) {
      if (!fileCids.has(c.cid)) continue;
      const role = c.file_role;
      if (role !== "resume" && role !== "cover_letter") continue; // no file for "other"
      const file = await fetchRoleFile(jobId, role, acceptByCid[c.cid], cache);
      if (file) files[c.cid] = file;
      else missing.push({ cid: c.cid, role });
    }
  }
  return { files, missing };
}

// Lever parses an uploaded resume and may overwrite name/email/phone - defer the
// resume file write until every text/select field has been filled.
function splitLeverResumeWrite(results, files) {
  let pending = null;
  const outResults = [];
  for (const r of results || []) {
    const controls = [];
    for (const c of r.controls || []) {
      if (c.file_role === "resume") {
        if (files && files[c.cid]) pending = { cid: c.cid, file: files[c.cid] };
        continue;
      }
      controls.push(c);
    }
    if (controls.length) outResults.push({ handle: r.handle, controls });
  }
  const outFiles = {};
  for (const [cid, fd] of Object.entries(files || {})) {
    if (!pending || cid !== pending.cid) outFiles[cid] = fd;
  }
  return { results: outResults, files: outFiles, pending };
}

async function uploadLeverResumeLast(tabId, pending) {
  if (!pending || !pending.file || tabId == null) return false;
  try {
    const res = await tabSend(tabId, { type: "AF_LV_UPLOAD_RESUME", file: pending.file });
    return !!(res && res.uploaded);
  } catch {
    return false;
  }
}

async function uploadWorkableResumeLast(tabId, pending) {
  if (!pending || !pending.file || tabId == null) return false;
  try {
    const res = await tabSend(tabId, { type: "AF_WB_UPLOAD_RESUME", file: pending.file });
    return !!(res && res.uploaded);
  } catch {
    return false;
  }
}

async function uploadBreezyResumeLast(tabId, pending) {
  if (!pending || !pending.file || tabId == null) return false;
  try {
    const res = await tabSend(tabId, { type: "AF_BZY_UPLOAD_RESUME", file: pending.file });
    return !!(res && res.uploaded);
  } catch {
    return false;
  }
}

async function uploadAshbyResumeLast(tabId, pending) {
  if (!pending || !pending.file || tabId == null) return false;
  try {
    const res = await tabSend(tabId, { type: "AF_ASHBY_UPLOAD_RESUME", file: pending.file });
    return !!(res && res.uploaded);
  } catch {
    return false;
  }
}

// Give the application tab OS focus so React commit-on-blur / focus handlers run
// (Workday-proven: side panel keeps document.hasFocus() false on the page).
async function focusApplicationTab(tabId) {
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    /* tab/window may be gone */
  }
  await delay(350);
}

// Send a write pass to the content script and wait until it reports completion
// (or a generous timeout). Awaiting completion lets us re-scan the DOM for
// fields that only render after a prior answer commits.
function writeAndWait(tabId, results, files) {
  return new Promise((resolve) => {
    const passId = ++writePassSeq;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      writeWaiter = null;
      resolve();
    };
    // Only the matching pass's completion resolves this wait, so the loop never
    // advances to the next extract on a stale/early signal from another pass.
    writeWaiter = { passId, finish };
    if (tabId != null) {
      try {
        tabSend(tabId, { type: "AF_WRITE", passId, results, files });
      } catch {
        /* ignore */
      }
    }
    // Poll-verify + retries per control can take a while on slow pages.
    setTimeout(finish, 25000);
  });
}

// Max fill -> re-scan -> fill-new cycles. Bounded so a field that can never be
// filled (needs_user) can't loop forever; a couple of passes covers the common
// "answer X reveals field Y" progressive forms (e.g. Hispanic=No reveals Race).
const AUTOFILL_MAX_PASSES = 4;
const SR_MAX_PAGES = 8; // SmartRecruiters multi-step applications: hard cap on steps
const BZY_MAX_PAGES = 6; // Breezy.hr multi-step applications: hard cap on sections
const ICIMS_MAX_PAGES = 10; // iCIMS itineraries are typically 3-5 steps; cap well above

// Re-run auto-discovery on the current page and wait for the application
// container to register. Used between SmartRecruiters steps: after clicking
// "Next", the previous step's controls detach, so we re-select the (persistent
// or freshly mounted) form container to get live handles for the next step.
async function rediscoverForm(tabId) {
  setAutofill({ fields: [] });
  // Re-trigger discovery REPEATEDLY: the next step's <oc-oneclick-form> remounts
  // asynchronously and, on a slow network, often lands AFTER a single
  // AF_AUTOSELECT's internal retry window (~2.4s) expires. Re-sending every couple
  // seconds (for up to ~16s) guarantees a discovery pass fires once the step's
  // form is actually in the DOM, instead of giving up and ending the run.
  const deadline = Date.now() + 16000;
  let lastSend = 0;
  while (Date.now() < deadline) {
    if (Date.now() - lastSend > 2200) {
      lastSend = Date.now();
      try {
        await tabBroadcast(tabId, { type: "AF_AUTOSELECT" });
      } catch {
        /* ignore */
      }
    }
    if (state.autofill.fields.length) {
      await delay(400); // let the freshly mounted step settle before extracting
      return true;
    }
    await delay(200);
  }
  return state.autofill.fields.length > 0;
}

// Fill every control currently discovered on the page (one application step):
// platform prep -> multi-pass LLM fill -> controlled-form reconciliation.
// Labels and "needs your input" items accumulate into `ctx` across steps.
// Returns the last extracted specs (empty if nothing could be read).
async function fillCurrentPage(tabId, eng, ctx, isFirstPage) {
  // Greenhouse: ensure the form has a repeating education row for every entry
  // in the candidate's history before we extract + fill (Workday-style).
  if (eng && eng.platform === "greenhouse") {
    setAutofill({ runStatus: "Adding your education history…" });
    await prepareGreenhouseEducation(tabId);
  }
  if (eng && eng.platform === "applytojob") {
    setAutofill({ runStatus: "Preparing the resume upload…" });
    await prepareApplyToJob(tabId);
  }
  if (eng && eng.platform === "manatal") {
    setAutofill({ runStatus: "Accepting terms…" });
    await prepareManatal(tabId);
  }
  // iCIMS: write the phone block and the "Create a login" block before
  // extraction so those fields already read as filled and never reach the model.
  if (eng && eng.platform === "icims") {
    setAutofill({ runStatus: "Filling your phone and portal login…" });
    await prepareIcims(tabId, ctx);
  }
  if (eng && eng.platform === "recruiterflow") {
    setAutofill({ runStatus: "Adding your work & education history…" });
    await prepareRecruiterFlow(tabId);
  }
  // SmartRecruiters: add + Save Experience/Education entries for whichever step
  // hosts those sections (a no-op on steps that don't, e.g. profiles/resume).
  if (eng && eng.platform === "smartrecruiters") {
    setAutofill({ runStatus: "Adding your work & education history…" });
    await prepareSmartRecruiters(tabId);
  }
  if (eng && eng.platform === "workable" && isFirstPage) {
    setAutofill({ runStatus: "Adding your work & education history…" });
    await prepareWorkable(tabId);
  }
  // Replay remembered identity answers (EEO/work-auth/consent) before extract
  // so those controls are already filled and skip the harvest + LLM pass.
  if (eng && eng.mode === "select") {
    setAutofill({ runStatus: "Adding your cover letter…" });
    await prepareCoverLetter(tabId);
    setAutofill({ runStatus: "Filling your saved answers…" });
    await prepareCachedAnswers(tabId, eng.platform);
    // Commit any values the browser autofilled into the form's framework state.
    // The engine skips already-filled controls, so a browser-autofilled value
    // that never fired React's onChange would otherwise stay invisible to a
    // controlled form (e.g. Ashby) and be rejected as "missing" on submit.
    await commitPrefilled(tabId);
  }
  const handles = state.autofill.fields.map((f) => f.handle);
  const attemptedKeys = new Set(); // stable control keys already sent to the LLM (this step)
  let lastSpecs = [];

  const maxPasses = eng && eng.platform === "pinpoint" ? 5 : AUTOFILL_MAX_PASSES;
  const passDelayMs = eng && eng.platform === "pinpoint" ? 750 : 500;
  const isLever = eng && eng.platform === "lever";
  const isWorkable = eng && eng.platform === "workable";
  const isBreezy = eng && eng.platform === "breezy";
  const isAshby = eng && eng.platform === "ashby";
  let leverResumePending = null;
  let workableResumePending = null;
  let breezyResumePending = null;
  let ashbyResumePending = null;

  for (let pass = 0; pass < maxPasses; pass++) {
    // Re-extract the live DOM each pass. Already-filled controls report
    // filled:true (and skip option harvesting); newly rendered controls show up.
    setAutofill({ runStatus: pass === 0 ? "Reading the application fields…" : "Checking for new fields…" });
    const specs = await extractSpecs(tabId, handles);
    const specControls = specs.reduce((n, s) => n + ((s.controls && s.controls.length) || 0), 0);
    if (!specs.length || !specControls) {
      if (pass === 0 && isFirstPage) {
        const onSurvey =
          eng &&
          eng.platform === "workable" &&
          state.autofill.fields.some((f) => /survey/i.test(f.label || ""));
        setAutofill({
          error: onSurvey
            ? "Could not read the survey questions. Reload the page and click Start autofill again."
            : "Could not read the selected fields. Try reselecting.",
        });
      }
      break;
    }
    lastSpecs = specs;

    // Only fill controls that are not already filled on the page and that we
    // have not already attempted in a prior pass (keyed by stable identity).
    const fresh = specs
      .map((f) => ({
        handle: f.handle,
        label: f.label,
        html: f.html || "",
        controls: (f.controls || []).filter((c) => !c.filled && !attemptedKeys.has(c.key)),
      }))
      .filter((f) => f.controls.length);
    if (!fresh.length) break;

    for (const f of fresh) {
      for (const c of f.controls) {
        attemptedKeys.add(c.key);
        ctx.labelByCid[c.cid] = c.label || f.label || "Field";
      }
    }

    // Strip client-only fields (key, filled) before sending to the LLM. The
    // 'html' snapshot carries each control's options inline (DOM-with-options).
    const apiSpecs = fresh.map((f) => ({
      handle: f.handle,
      label: f.label,
      html: f.html,
      controls: f.controls.map(({ key, filled, ...c }) => c),
    }));

    const freshCount = fresh.reduce((n, f) => n + f.controls.length, 0);
    setAutofill({ runStatus: `Choosing answers for ${freshCount} field${freshCount === 1 ? "" : "s"}…` });
    const resp = await api.autofill(state.job.job_id, apiSpecs, buildPreferences());
    const results = (resp && resp.results) || [];

    try {
      console.groupCollapsed(`[autofill] pass ${pass}: sent specs -> LLM results`);
      console.log("sent fields/controls:", JSON.parse(JSON.stringify(apiSpecs)));
      console.log("LLM results:", JSON.parse(JSON.stringify(results)));
      console.groupEnd();
    } catch {}

    // Normalize file roles from labels when the model leaves them as "other"/empty,
    // then decide file needs_user from whether we can actually download the file —
    // never from the LLM's guess (it has no visibility into generated PDFs).
    normalizeFileRolesInResults(results, apiSpecs);

    for (const r of results) {
      for (const c of r.controls || []) {
        if (!c.needs_user) continue;
        // File controls are handled below via fetchFilesForResults.
        if (c.file_role === "resume" || c.file_role === "cover_letter") {
          c.needs_user = false;
          c.reason = null;
          continue;
        }
        const label = ctx.labelByCid[c.cid] || "Field";
        if (looksLikeResumeOrCoverLabel(label)) {
          c.needs_user = false;
          c.reason = null;
          continue;
        }
        ctx.needsUser.push({
          cid: c.cid,
          label,
          reason: c.reason || "Needs your input",
        });
      }
    }

    const { files, missing } = await fetchFilesForResults(state.job.job_id, results, apiSpecs);
    for (const m of missing) {
      const roleLabel = m.role === "cover_letter" ? "Cover letter" : "Resume";
      const why =
        m.role === "cover_letter"
          ? "no cover letter file was generated for this job (set up a cover letter template and build it)"
          : "no resume file was generated for this job yet";
      // Avoid duplicate rows if a prior pass already reported this cid.
      if (!ctx.needsUser.some((x) => x.cid === m.cid)) {
        ctx.needsUser.push({
          cid: m.cid,
          label: ctx.labelByCid[m.cid] || roleLabel,
          reason: `Upload manually - ${why}`,
        });
      }
    }
    if (missing.length) {
      try {
        console.warn("[autofill] missing generated files for upload:", missing);
      } catch {}
    }

    const writeCount = results.reduce((n, r) => n + (r.controls || []).length, 0);
    setAutofill({ runStatus: `Filling ${writeCount} field${writeCount === 1 ? "" : "s"} on the page…` });
    let writeResults = results;
    let writeFiles = files;
    if (isLever) {
      const split = splitLeverResumeWrite(results, files);
      writeResults = split.results;
      writeFiles = split.files;
      if (split.pending) leverResumePending = split.pending;
    }
    if (isWorkable) {
      const split = splitLeverResumeWrite(results, files);
      writeResults = split.results;
      writeFiles = split.files;
      if (split.pending) workableResumePending = split.pending;
    }
    if (isBreezy) {
      const split = splitLeverResumeWrite(results, files);
      writeResults = split.results;
      writeFiles = split.files;
      if (split.pending) breezyResumePending = split.pending;
    }
    // Ashby parses uploaded resumes and overwrites name/email/location (Ashby
    // product autofill; file.js documents the race). Defer like Lever/Breezy.
    if (isAshby) {
      const split = splitLeverResumeWrite(results, files);
      writeResults = split.results;
      writeFiles = split.files;
      if (split.pending) ashbyResumePending = split.pending;
      // Keep the non-file answers so we can re-apply after resume parse.
      ctx.ashbyReapply = writeResults;
    }
    await writeAndWait(tabId, writeResults, writeFiles);

    // Drop false "needs you" rows for controls that actually filled/attached.
    if (ctx.needsUser.length) {
      const st = state.autofill.statuses || {};
      ctx.needsUser = ctx.needsUser.filter((item) => {
        const s = st[item.cid];
        return s !== "filled" && s !== "attached";
      });
    }

    // Remember stable identity answers (EEO/work-auth/consent) that actually
    // committed, so future jobs replay them without harvesting menus or
    // calling the LLM. Keyed by category; the exact chosen option text is
    // stored and fuzzy-matched on replay.
    const learned = {};
    for (const r of results) {
      for (const c of r.controls || []) {
        const cat = answerCategory(ctx.labelByCid[c.cid] || "");
        const ans = c.option || c.value;
        if (cat && ans && state.autofill.statuses[c.cid] === "filled") learned[cat] = String(ans);
      }
    }
    if (Object.keys(learned).length) {
      try {
        await store.saveAnswerPairs(state.user && state.user.user_id, eng && eng.platform, learned);
      } catch {}
    }

    // Give conditionally rendered fields a moment to mount before re-scanning.
    await new Promise((r) => setTimeout(r, passDelayMs));
  }

  // Final reconciliation for controlled forms (e.g. Ashby): a value can sit in
  // the DOM while the framework never recorded it - the early commit runs
  // before these fields are written, and the engine skips any control that
  // already holds a value, so a late/skipped write never fires React's
  // onChange and submit reports the field "missing". The browser also RE-applies
  // autofill to name/phone/company fields as focus moves during our writes, so a
  // value can appear after the last write. Let the page settle, then re-commit
  // every text field's CURRENT value through the React-safe path twice so a late
  // browser refill is still caught. It's idempotent (same text).
  // Ashby: focus the tab (side panel steals OS focus - Workday-proven), commit,
  // upload resume LAST, wait for Ashby's resume parser, then re-apply text
  // answers so parse overwrites cannot leave Name/Email empty in React state.
  if (eng && eng.mode === "select") {
    const ashby = eng.platform === "ashby";
    setAutofill({ runStatus: "Finalizing the form…" });
    if (ashby) await focusApplicationTab(tabId);
    await delay(ashby ? 500 : 400);
    await commitPrefilled(tabId);
    await delay(ashby ? 300 : 200);
    await commitPrefilled(tabId);
    if (ashby) {
      await delay(250);
      await commitPrefilled(tabId);
    }
  }
  if (eng && eng.platform === "ashby" && ashbyResumePending) {
    setAutofill({ runStatus: "Uploading your resume…" });
    await focusApplicationTab(tabId);
    const ok = await uploadAshbyResumeLast(tabId, ashbyResumePending);
    if (ok) {
      console.log("[autofill] Ashby resume uploaded last (after text commit)");
      markFileControlAttached(ctx, ashbyResumePending.cid);
      // Structured resume parse populates/races name+email asynchronously.
      setAutofill({ runStatus: "Waiting for Ashby resume parse…" });
      await delay(1800);
      if (ctx.ashbyReapply && ctx.ashbyReapply.length) {
        setAutofill({ runStatus: "Restoring fields after resume parse…" });
        await focusApplicationTab(tabId);
        await writeAndWait(tabId, ctx.ashbyReapply, {});
        await delay(300);
        await commitPrefilled(tabId);
        await delay(250);
        await commitPrefilled(tabId);
      } else {
        await commitPrefilled(tabId);
        await delay(250);
        await commitPrefilled(tabId);
      }
    }
  }
  if (eng && eng.platform === "smartrecruiters") {
    try {
      const ticked = await tabSend(tabId, { type: "AF_SR_TICK_CHECKBOXES" });
      if (ticked && ticked.ticked) {
        console.log("[autofill] SR final checkbox sweep:", ticked.ticked);
      }
    } catch {
      /* ignore */
    }
  }
  if (eng && eng.platform === "pinpoint") {
    try {
      const ticked = await tabSend(tabId, { type: "AF_PP_TICK_CONSENT" });
      if (ticked && ticked.ticked) {
        console.log("[autofill] Pinpoint consent ticked");
      }
    } catch {
      /* ignore */
    }
  }
  if (eng && eng.platform === "manatal") {
    try {
      const ticked = await tabSend(tabId, { type: "AF_MANATAL_PREP" });
      if (ticked && ticked.ticked) {
        console.log("[autofill] Manatal consent ticked:", ticked.ticked);
      }
    } catch {
      /* ignore */
    }
  }
  if (isLever) {
    if (leverResumePending) {
      setAutofill({ runStatus: "Uploading your resume…" });
      const ok = await uploadLeverResumeLast(tabId, leverResumePending);
      if (ok) {
        console.log("[autofill] Lever resume uploaded last");
        markFileControlAttached(ctx, leverResumePending.cid);
        await delay(1200);
        await commitPrefilled(tabId);
      }
    }
  }
  if (isWorkable) {
    if (workableResumePending) {
      setAutofill({ runStatus: "Uploading your resume…" });
      const ok = await uploadWorkableResumeLast(tabId, workableResumePending);
      if (ok) {
        console.log("[autofill] Workable resume uploaded last");
        markFileControlAttached(ctx, workableResumePending.cid);
        await delay(1200);
        await commitPrefilled(tabId);
      }
    }
  }
  if (isBreezy && breezyResumePending) {
    ctx.breezyResumePending = breezyResumePending;
  }

  return lastSpecs;
}

function markFileControlAttached(ctx, cid) {
  if (!cid) return;
  const statuses = { ...(state.autofill.statuses || {}), [cid]: "attached" };
  if (ctx && Array.isArray(ctx.needsUser)) {
    ctx.needsUser = ctx.needsUser.filter((item) => item.cid !== cid);
  }
  setAutofill({
    statuses,
    needsUser: ctx && Array.isArray(ctx.needsUser) ? ctx.needsUser : state.autofill.needsUser,
  });
}

async function runAutofill() {
  if (!state.job || !state.autofill.fields.length || state.autofill.running) return;
  const tabId = state.autofill.tabId;
  // Clicking run leaves picking mode and clears the on-page selection outlines so
  // the page is clean while filling (control attributes are kept for the writer).
  if (tabId != null) {
    try {
      await tabBroadcast(tabId, { type: "AF_STOP" });
      await tabBroadcast(tabId, { type: "AF_HIDE_MARKS" });
    } catch {
      /* ignore */
    }
  }
  setAutofill({ running: true, runStatus: "Preparing the form…", error: null, statuses: {}, needsUser: [], picking: false });
  try {
    const eng = state.autofill.engine;
    const ctx = { labelByCid: {}, needsUser: [] };

    // Workable: after submit the application form is replaced by a survey on the
    // same tab - re-scan so we target survey-form instead of a detached handle.
    if (eng && eng.platform === "workable") {
      setAutofill({ runStatus: "Scanning the page…" });
      const ok = await rediscoverForm(tabId);
      if (!ok || !state.autofill.fields.length) {
        setAutofill({
          running: false,
          runStatus: null,
          error: "Could not find the application or survey form on this page.",
        });
        return;
      }
    }

    // iCIMS: EVERY step is a separate server-rendered document, so a handle
    // discovered on an earlier step is detached the moment the page moves on -
    // whether a previous run advanced it or the candidate clicked Submit
    // themselves. Extraction resolves handles through relocate(), which returns
    // null for a handle no element carries any more, so the run would read zero
    // controls and report "Could not read the selected fields" while sitting on a
    // perfectly fillable step. Re-discover against whatever step is actually open
    // so the run always starts from there.
    if (eng && eng.platform === "icims") {
      setAutofill({ runStatus: "Finding the current step…" });
      const found = await rediscoverForm(tabId);
      if (!found || !state.autofill.fields.length) {
        setAutofill({
          running: false,
          runStatus: null,
          error: "Could not find an iCIMS application form on this page.",
        });
        return;
      }
    }

    // iCIMS: the resume goes up FIRST. Attaching it submits the form and iCIMS
    // re-renders the profile pre-filled from the parsed resume, so any value
    // written beforehand would be thrown away. Re-discover afterwards: the
    // reload detached every handle we hold.
    if (eng && eng.platform === "icims") {
      const reloaded = await uploadIcimsResumeFirst(tabId, eng, ctx);
      if (reloaded) {
        setAutofill({ runStatus: "Re-reading the form after the resume upload…" });
        const ok = await rediscoverForm(tabId);
        if (!ok || !state.autofill.fields.length) {
          setAutofill({
            running: false,
            runStatus: null,
            error: "iCIMS reloaded after the resume upload but the profile form could not be found again. Click Start autofill once more.",
          });
          return;
        }
      }
    }

    let lastSpecs = await fillCurrentPage(tabId, eng, ctx, true);

    // SmartRecruiters: longer applications split across steps with a footer
    // "Next" button (the final step shows "Submit" instead). Fill the step, click
    // Next, re-discover the freshly rendered step, and fill again - repeating
    // until Next is gone or navigation is blocked. We never auto-submit.
    if (eng && eng.platform === "smartrecruiters" && lastSpecs.length) {
      for (let page = 1; page < SR_MAX_PAGES; page++) {
        setAutofill({ runStatus: "Moving to the next step…" });
        const nav = await tabSend(tabId, { type: "AF_SR_NEXT" });
        console.log("[autofill] SR navigate result:", nav);
        if (!nav || !nav.advanced) {
          // Blocked by a required field we couldn't satisfy: tell the user which
          // ones so they can complete them and continue manually.
          if (nav && nav.blocked && Array.isArray(nav.errors) && nav.errors.length) {
            for (const lab of nav.errors) {
              ctx.needsUser.push({ cid: "sr-block:" + lab, label: lab, reason: "Complete this required field to continue to the next step" });
            }
          }
          break; // reached the Submit step, or navigation blocked
        }
        const ok = await rediscoverForm(tabId);
        if (!ok) break;
        lastSpecs = await fillCurrentPage(tabId, eng, ctx, false);
      }
    }

    // Workable: after the application form (or on a survey-only page), fill the
    // post-submit survey when it mounts. Re-discover so survey radios replace the
    // detached application handles. We never auto-submit the survey.
    if (eng && eng.platform === "workable") {
      for (let step = 0; step < 2; step++) {
        setAutofill({ runStatus: "Checking for survey questions…" });
        await delay(400);
        let hasSurvey = false;
        try {
          const probe = await tabSend(tabId, { type: "AF_WB_HAS_SURVEY" });
          hasSurvey = !!(probe && probe.survey);
        } catch {}
        if (!hasSurvey) break;
        const ok = await rediscoverForm(tabId);
        if (!ok) break;
        lastSpecs = await fillCurrentPage(tabId, eng, ctx, false);
      }
    }

    // iCIMS: the application spans a variable number of server-rendered steps
    // ("Candidate Profile -> Candidate Questions -> EEO -> Job Specific
    // Questions"), each a full POST that reloads the tab. The header lists the
    // whole itinerary up front (.iCIMS_Steps, "Step 2 of 4"), so we know BEFORE
    // clicking whether the next Submit is the final one.
    //
    // We advance through the middle steps automatically and deliberately stop on
    // the last one: that Submit files the application, which is the candidate's
    // call, matching every other engine here.
    //
    // Gated on lastSpecs like the loops above: fillCurrentPage assigns lastSpecs
    // as soon as extraction reads ANY control, before it filters out the ones
    // already filled - so a step that was fully pre-filled still reports specs,
    // and an empty result means the step could not be read at all. Submitting a
    // step we never read would post it blank.
    if (eng && eng.platform === "icims" && lastSpecs.length) {
      for (let page = 1; page < ICIMS_MAX_PAGES; page++) {
        const stage = await icimsStage(tabId);
        if (!stage) break; // no iCIMS form on this page - nothing left to drive
        if (!stage.hasSubmit) break;

        // Only ever click when the itinerary PROVES another step follows. An
        // absent indicator, or one that marks no step current (as the page after
        // the last step does), means we cannot tell - and a wrong guess files the
        // application. Hand over in every one of those cases.
        const positionKnown = stage.stepsPresent && stage.step > 0 && stage.total > 0;
        if (!positionKnown || stage.last) {
          ctx.needsUser.push({
            cid: "icims-submit",
            label: positionKnown
              ? `Final step (${stage.step} of ${stage.total}): ${stage.stepTitle || "Submit"}`
              : stage.stepTitle || "Submit this step",
            reason: positionKnown
              ? "Everything is filled. Review it and click Submit to send your application."
              : "Everything is filled. Review it and click Submit - this page doesn't say whether more steps follow.",
          });
          break;
        }

        setAutofill({
          runStatus: `Submitting step ${stage.step} of ${stage.total}…`,
        });
        const nav = await icimsAdvance(tabId, eng, stage);
        console.log("[autofill] iCIMS advance:", nav);
        if (!nav.advanced) {
          // Rejected by the server: surface the field-level reasons it rendered.
          for (const msg of nav.errors || []) {
            ctx.needsUser.push({
              cid: "icims-block:" + msg,
              label: stage.stepTitle || `Step ${stage.step}`,
              reason: msg,
            });
          }
          if (!(nav.errors || []).length) {
            ctx.needsUser.push({
              cid: "icims-stuck",
              label: stage.stepTitle || `Step ${stage.step} of ${stage.total}`,
              reason: nav.timedOut
                ? "iCIMS did not finish loading the next step. Continue from the page as it stands."
                : "iCIMS would not accept this step. Check the highlighted fields and continue manually.",
            });
          }
          break;
        }

        setAutofill({
          runStatus: `Reading step ${nav.stage.step} of ${nav.stage.total}…`,
        });
        const ok = await rediscoverForm(tabId);
        if (!ok) {
          ctx.needsUser.push({
            cid: "icims-stuck",
            label: nav.stage.stepTitle || `Step ${nav.stage.step}`,
            reason: "The next step loaded but its form could not be read. Continue from the page as it stands.",
          });
          break;
        }
        lastSpecs = await fillCurrentPage(tabId, eng, ctx, false);
        if (!lastSpecs.length) {
          // The step loaded but nothing could be read from it - never submit a
          // step blind.
          ctx.needsUser.push({
            cid: "icims-unread",
            label: nav.stage.stepTitle || `Step ${nav.stage.step} of ${nav.stage.total}`,
            reason: "This step's fields could not be read. Complete it on the page and continue.",
          });
          break;
        }
      }
    }

    // Breezy: multi-step applications hide later sections behind Continue. Fill
    // the visible step, advance, re-discover, and fill again - never auto-submit.
    if (eng && eng.platform === "breezy" && lastSpecs.length) {
      for (let page = 1; page < BZY_MAX_PAGES; page++) {
        setAutofill({ runStatus: "Moving to the next step…" });
        const nav = await tabSend(tabId, { type: "AF_BZY_NEXT" });
        if (!nav || !nav.advanced) break;
        const ok = await rediscoverForm(tabId);
        if (!ok) break;
        lastSpecs = await fillCurrentPage(tabId, eng, ctx, false);
      }
    }

    if (eng && eng.platform === "breezy" && ctx.breezyResumePending) {
      setAutofill({ runStatus: "Uploading your resume…" });
      const ok = await uploadBreezyResumeLast(tabId, ctx.breezyResumePending);
      if (ok) {
        console.log("[autofill] Breezy resume uploaded last");
        markFileControlAttached(ctx, ctx.breezyResumePending.cid);
        await delay(1200);
        await commitPrefilled(tabId);
      }
    }

    // Final sweep: never show a manual-review row for controls that attached/filled.
    const finalStatuses = state.autofill.statuses || {};
    ctx.needsUser = (ctx.needsUser || []).filter((item) => {
      const s = finalStatuses[item.cid];
      return s !== "filled" && s !== "attached";
    });

    setAutofill({ running: false, runStatus: null, specs: lastSpecs, needsUser: ctx.needsUser });
  } catch (err) {
    setAutofill({ running: false, runStatus: null, error: (err && err.message) || "Autofill failed." });
  }
}

// ── rendering ────────────────────────────────────────────────────────────────

function render() {
  root.innerHTML = "";
  let view;
  if (state.view === "loading") view = renderSpinner("Loading…");
  else if (state.view === "login") view = renderLogin();
  else if (state.view === "home") view = renderHome();
  else if (state.view === "job") view = renderJob();
  root.appendChild(view);

  const modal = renderModal();
  if (modal) root.appendChild(modal);
  paintToast();
}

function renderModal() {
  const m = state.modal;
  if (!m) return null;
  const overlay = el("div", {
    class: "modal-overlay",
    onclick: (e) => {
      if (e.target === overlay) closeModal();
    },
  });
  const box = el("div", { class: "modal" }, [
    el("div", { class: "modal-icon " + (m.tone || "") }, icon(ICON_ALERT, "modal-icon-svg")),
    el("div", { class: "modal-title" }, m.title),
    m.message ? el("div", { class: "modal-text muted" }, m.message) : null,
    el("div", { class: "modal-actions" }, [
      el("button", { class: "btn", disabled: m.busy, onclick: () => closeModal() }, "Cancel"),
      el(
        "button",
        {
          class: "btn " + (m.tone === "danger" ? "danger" : "primary"),
          disabled: m.busy,
          onclick: () => m.onConfirm && m.onConfirm(),
        },
        m.busy ? "Working…" : m.confirmLabel || "Confirm"
      ),
    ]),
  ]);
  overlay.appendChild(box);
  return overlay;
}

function renderLogin() {
  const wrap = el("div", { class: "login-screen" });

  const bg = el("div", { class: "login-bg" }, [
    el("img", { class: "login-bg-img", src: "login-still.jpg", alt: "" }),
    el("div", { class: "login-bg-scrim" }),
  ]);
  wrap.appendChild(bg);

  const outer = el("div", { class: "login-card-outer" });
  outer.appendChild(el("div", { class: "login-card-glow" }));

  const card = el("div", { class: "login-card" });
  card.appendChild(el("div", { class: "login-card-sheen" }));

  const inner = el("div", { class: "login-card-inner" });
  inner.appendChild(
    el("div", { class: "login-brand" }, [
      el("div", { class: "login-logo-wrap" }, [
        el("img", { class: "login-logo", src: "atomspace-logo.png", alt: "Atomspace" }),
      ]),
      el("h1", { class: "login-title" }, "Atomspace"),
      el("p", { class: "login-subtitle" }, "Your AI job application workspace"),
    ])
  );

  const emailInput = el("input", {
    class: "login-input",
    type: "email",
    id: "f-email",
    placeholder: "name@example.com",
    autocomplete: "email",
    value: loginDraft.email,
    oninput: (e) => {
      loginDraft.email = e.target.value;
    },
  });
  const passInput = el("input", {
    class: "login-input login-input-password",
    type: loginDraft.showPassword ? "text" : "password",
    id: "f-pass",
    placeholder: "••••••••",
    autocomplete: "current-password",
    value: loginDraft.password,
    oninput: (e) => {
      loginDraft.password = e.target.value;
    },
  });
  const togglePass = el(
    "button",
    {
      type: "button",
      class: "login-toggle-pass",
      "aria-label": loginDraft.showPassword ? "Hide password" : "Show password",
      onclick: () => {
        loginDraft.showPassword = !loginDraft.showPassword;
        setState({});
      },
    },
    icon(loginDraft.showPassword ? ICON_EYE_OFF : ICON_EYE, "login-toggle-pass-ico")
  );

  const rememberId = "login-remember";
  const rememberInput = el("input", {
    type: "checkbox",
    id: rememberId,
    class: "login-remember-input",
    checked: loginDraft.remember,
    onchange: (e) => {
      loginDraft.remember = e.target.checked;
    },
  });
  const rememberLabel = el("label", { class: "login-remember", for: rememberId }, [
    el("span", { class: "login-remember-box" }, [
      rememberInput,
      el("span", { class: "login-remember-mark" }, icon(ICON_CHECK, "login-remember-check")),
    ]),
    el("span", {}, "Remember me"),
  ]);

  const form = el(
    "form",
    {
      class: "login-form",
      onsubmit: (e) => {
        e.preventDefault();
        if (!state.loginLoading) doLogin(loginDraft.email.trim(), loginDraft.password);
      },
    },
    [
      loginField("Email", ICON_MAIL, emailInput),
      loginField("Password", ICON_LOCK, passInput, togglePass),
      rememberLabel,
      state.error ? el("div", { class: "login-error" }, state.error) : null,
      el(
        "button",
        {
          type: "submit",
          class: "login-submit" + (state.loginLoading ? " loading" : ""),
          disabled: state.loginLoading,
        },
        state.loginLoading
          ? [el("span", { class: "spinner-sm login-submit-spinner" }), el("span", {}, "Signing in…")]
          : [el("span", { class: "login-submit-shine" }), el("span", {}, "Sign In")]
      ),
    ]
  );

  inner.appendChild(form);
  card.appendChild(inner);
  outer.appendChild(card);
  outer.appendChild(el("div", { class: "login-star-border" }));
  wrap.appendChild(outer);
  return wrap;
}

function loginField(label, iconSvg, input, trailing) {
  const field = el("div", { class: "login-field" });
  field.appendChild(el("label", { class: "login-label" }, label));
  const wrap = el("div", { class: "login-input-wrap" });
  wrap.appendChild(el("span", { class: "login-field-icon", html: iconSvg }));
  wrap.appendChild(input);
  if (trailing) wrap.appendChild(trailing);
  field.appendChild(wrap);
  return field;
}

function field(label, input) {
  return el("label", { class: "field" }, [el("span", {}, label), input]);
}

function renderHome() {
  const wrap = el("div", { class: "screen" });
  wrap.appendChild(renderHeader());

  if (state.sync) wrap.appendChild(renderSyncBanner());
  if (state.error) wrap.appendChild(el("div", { class: "error", onclick: () => setState({ error: null }) }, state.error));

  if (state.homeTab === "hub") {
    wrap.appendChild(renderWeeklyProgress());
    wrap.appendChild(renderHomeTiles());
  } else {
    wrap.appendChild(renderHomeSection());
  }
  return wrap;
}

const HOME_SECTION_META = {
  progress: { title: "In progress", empty: "No applications in progress yet." },
  today: { title: "Today's jobs", empty: "No jobs were added today." },
  all: { title: "Total jobs", empty: "No jobs in the system yet." },
  ready: { title: "Ready to apply", empty: "No ready-to-apply jobs yet." },
  best: { title: "Best jobs", empty: "No best-match jobs yet." },
  remote: { title: "Remote jobs", empty: "No remote jobs yet." },
  mine: { title: "Posted by me", empty: "You have not posted any jobs yet." },
  tailor: { title: "Tailor resume", empty: null },
  stats: { title: "Statistics", empty: null },
  settings: { title: "Settings", empty: null },
};

function renderHomeSection() {
  const meta = HOME_SECTION_META[state.homeTab] || { title: "Home" };
  const section = el("div", { class: "home-section" });
  section.appendChild(
    el("div", { class: "home-section-head" }, [
      el("button", { class: "btn link home-back", onclick: () => backToHub() }, [
        icon(ICON_BACK, "btn-ico"),
        el("span", {}, "Home"),
      ]),
      el("h2", { class: "home-section-title" }, meta.title),
    ])
  );
  section.appendChild(renderActiveTab());
  return section;
}

// Hub tile grid (matches the sketched layout).
function renderWeeklyProgress() {
  const wp = state.weeklyProgress;
  const series = (wp && wp.series) || [];
  const totals = (wp && wp.totals) || { posted: 0, recommended: 0, applied: 0 };
  const minScore = wp && wp.min_match_score != null ? wp.min_match_score : null;

  const wrap = el("div", { class: "weekly-progress" });
  wrap.appendChild(
    el("div", { class: "weekly-progress-head" }, [
      el("div", { class: "weekly-progress-title" }, "Weekly progress"),
      el(
        "div",
        { class: "weekly-progress-sub muted small" },
        minScore != null
          ? `Recommended = match ≥ ${minScore} (Preferences)`
          : "Posted · Recommended · Applied"
      ),
    ])
  );

  wrap.appendChild(
    el("div", { class: "weekly-legend" }, [
      legendSwatch("posted", "Posted", totals.posted),
      legendSwatch("recommended", "Recommended", totals.recommended),
      legendSwatch("applied", "Applied", totals.applied),
    ])
  );

  if (!series.length) {
    wrap.appendChild(
      el(
        "div",
        { class: "weekly-chart-empty muted small" },
        state.queueLoading ? "Loading chart…" : "No activity this week yet."
      )
    );
    return wrap;
  }

  wrap.appendChild(buildWeeklyChartSvg(series));
  return wrap;
}

function legendSwatch(key, label, total) {
  return el("div", { class: "weekly-legend-item" }, [
    el("span", { class: `weekly-swatch weekly-swatch-${key}` }),
    el("span", { class: "weekly-legend-label" }, label),
    el("span", { class: "weekly-legend-total" }, String(total)),
  ]);
}

function buildWeeklyChartSvg(series, opts = {}) {
  const dense = !!opts.dense || (series && series.length > 10);
  const W = 320;
  const H = opts.tall ? 176 : 148;
  const pad = { t: 12, r: 8, b: dense ? 26 : 28, l: 28 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const keys = ["posted", "recommended", "applied"];
  const maxVal = Math.max(1, ...series.flatMap((d) => keys.map((k) => Number(d[k]) || 0)));
  const n = Math.max(1, series.length);
  const groupW = innerW / n;
  const gap = dense ? 2 : 8;
  const barW = Math.max(dense ? 2 : 4, (groupW - gap) / keys.length);
  const labelStep = dense ? Math.max(1, Math.ceil(n / 6)) : 1;

  const yScale = (v) => pad.t + innerH - (v / maxVal) * innerH;
  const gridSteps = 3;
  let grid = "";
  for (let i = 0; i <= gridSteps; i++) {
    const v = Math.round((maxVal * i) / gridSteps);
    const y = yScale(v);
    grid += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" class="weekly-grid"/>`;
    grid += `<text x="${pad.l - 4}" y="${y + 3}" text-anchor="end" class="weekly-axis">${v}</text>`;
  }

  let bars = "";
  let labels = "";
  series.forEach((d, i) => {
    const gx = pad.l + i * groupW + (dense ? 1 : 4);
    keys.forEach((k, ki) => {
      const val = Number(d[k]) || 0;
      const h = (val / maxVal) * innerH;
      const x = gx + ki * barW;
      const y = pad.t + innerH - h;
      const tipDate = d.date || d.label || "";
      bars += `<rect x="${x}" y="${y}" width="${Math.max(barW - (dense ? 0.5 : 1), 1.5)}" height="${Math.max(h, val > 0 ? 2 : 0)}" rx="${dense ? 1 : 2}" class="weekly-bar weekly-bar-${k}"><title>${escapeHtml(String(tipDate))} · ${k} ${val}</title></rect>`;
    });
    if (i === 0 || i === n - 1 || i % labelStep === 0) {
      labels += `<text x="${gx + groupW / 2 - (dense ? 0 : 4)}" y="${H - 8}" text-anchor="middle" class="weekly-axis">${escapeHtml(d.label || "")}</text>`;
    }
  });

  const svg = `<svg viewBox="0 0 ${W} ${H}" class="weekly-chart-svg" role="img" aria-label="Activity chart">${grid}${bars}${labels}</svg>`;
  return el("div", { class: "weekly-chart", html: svg });
}

function renderHomeTiles() {
  const loading = !!state.queueLoading;
  const pc = state.platformCounts || {};
  const count = (n) =>
    loading
      ? el("span", { class: "home-tile-count loading" }, el("span", { class: "spinner-sm" }))
      : el("span", { class: "home-tile-count" }, String(n ?? 0));

  const tile = ({ id, label, countNode, variant, iconSvg, featured }) =>
    el(
      "button",
      {
        type: "button",
        class: `home-tile home-tile-${variant || id}${featured ? " home-tile-featured" : ""}`,
        onclick: () => openHomeSection(id),
      },
      [
        iconSvg ? el("span", { class: "home-tile-ico", html: iconSvg }) : null,
        el("span", { class: "home-tile-label" }, label),
        countNode || null,
      ]
    );

  const wrap = el("div", { class: "home-board", "aria-label": "Home" });
  wrap.appendChild(
    el("div", { class: "home-board-label muted small" }, "Platform dashboard")
  );
  wrap.appendChild(
    el("div", { class: "home-tiles home-tiles-platform", "aria-label": "Job lists" }, [
      tile({
        id: "all",
        label: "Total jobs",
        countNode: count(pc.total),
        iconSvg: ICON_BRIEFCASE,
      }),
      tile({
        id: "ready",
        label: "Ready to apply",
        countNode: count(pc.ready),
        iconSvg: ICON_CHECK,
        featured: true,
      }),
      tile({
        id: "best",
        label: "Best jobs",
        countNode: count(pc.best),
        iconSvg: ICON_STAR,
        featured: true,
      }),
      tile({
        id: "today",
        label: "Today's jobs",
        countNode: count(pc.today),
        iconSvg: ICON_BOLT,
      }),
      tile({
        id: "remote",
        label: "Remote jobs",
        countNode: count(pc.remote),
        iconSvg: ICON_CHIP,
      }),
      tile({
        id: "mine",
        label: "Posted by me",
        countNode: count(pc.mine),
        iconSvg: ICON_LIST,
      }),
    ])
  );
  wrap.appendChild(el("div", { class: "home-board-label muted small" }, "Tools"));
  wrap.appendChild(
    el("div", { class: "home-tiles home-tiles-tools", "aria-label": "Tools" }, [
      tile({
        id: "progress",
        label: "In progress",
        countNode: count(state.sessions.length),
        iconSvg: ICON_LIST,
      }),
      tile({
        id: "tailor",
        label: "Tailor resume",
        countNode: count(tailorInProgressJobs().length),
        iconSvg: ICON_DOC,
      }),
      tile({
        id: "stats",
        label: "Statistics",
        iconSvg: ICON_CHART,
      }),
      tile({
        id: "settings",
        label: "Settings",
        iconSvg: ICON_GEAR,
      }),
    ])
  );
  return wrap;
}

function renderTodaySubTabs() {
  const subs = [
    { id: "all", label: "All", count: state.todayCounts.all },
    { id: "platform", label: "From platform", count: state.todayCounts.platform },
    { id: "mine", label: "From me", count: state.todayCounts.mine },
  ];
  return el(
    "div",
    { class: "sub-tabs" },
    subs.map((t) =>
      el(
        "button",
        {
          class: "sub-tab" + (t.id === state.todaySubTab ? " active" : ""),
          onclick: () =>
            setState({
              todaySubTab: t.id,
              pageByTab: { ...state.pageByTab, today: 1 },
            }),
        },
        [el("span", {}, t.label), el("span", { class: "sub-tab-count" }, String(t.count))]
      )
    )
  );
}

function todayJobsForSubTab() {
  switch (state.todaySubTab) {
    case "mine":
      return state.todayMineQueue;
    case "platform":
      return state.todayPlatformQueue;
    default:
      return state.todayQueue;
  }
}

function todayEmptyMessage() {
  switch (state.todaySubTab) {
    case "mine":
      return "No jobs you added today.";
    case "platform":
      return "No platform jobs were added today.";
    default:
      return "No jobs were added today.";
  }
}

function jobToCard(j, onClick) {
  const rawMode = j.work_mode || (j.is_remote ? "remote" : null);
  return {
    jobId: j.id,
    title: j.title || "(untitled job)",
    company: j.company,
    location: j.location,
    workMode: normalizeCardWorkMode(rawMode),
    score: j.match_overall_score,
    source: String(j.source || sourceFromUrl(j.normalized_url || j.source_url) || "")
      .toLowerCase()
      .trim() || null,
    postedAt: j.posted_date || j.created_at || null,
    createdAt: j.created_at || null,
    chips: dashboardChips(j),
    onClick: onClick || (() => openJob(j.id, { redirect: true })),
  };
}

/** Map free-text work mode → remote | hybrid | onsite | null. */
function normalizeCardWorkMode(value) {
  if (value == null || value === "") return null;
  const mode = String(value).trim().toLowerCase();
  if (mode === "remote" || mode === "hybrid" || mode === "onsite") return mode;
  if (mode.includes("hybrid") || mode.includes("flexible")) return "hybrid";
  if (
    mode.includes("remote") ||
    mode.includes("wfh") ||
    mode.includes("work from home") ||
    mode.includes("work-from-home")
  ) {
    return "remote";
  }
  if (
    mode.includes("onsite") ||
    mode.includes("on-site") ||
    mode.includes("on site") ||
    mode.includes("in-office") ||
    mode.includes("in office") ||
    mode.includes("in-person")
  ) {
    return "onsite";
  }
  return null;
}

const DEFAULT_LIST_FILTERS = {
  title: "",
  company: "",
  workMode: "",
  source: "",
  sort: "created_at",
  order: "desc",
};

// Draft kept outside render state so typing does not remount inputs every keystroke.
let listFilterDraft = null;
let listFilterDebounce = null;

function getListFilters() {
  return {
    ...DEFAULT_LIST_FILTERS,
    ...(state.listFilters || {}),
    ...(listFilterDraft || {}),
  };
}

function resetListPages() {
  return {
    progress: 1,
    today: 1,
    all: 1,
    ready: 1,
    best: 1,
    remote: 1,
    mine: 1,
    tailor: 1,
  };
}

function commitListFilters(patch) {
  const next = { ...getListFilters(), ...(patch || {}) };
  listFilterDraft = null;
  if (listFilterDebounce) {
    clearTimeout(listFilterDebounce);
    listFilterDebounce = null;
  }
  setState({ listFilters: next, pageByTab: resetListPages() });
  if (state.homeTab === "tailor" && state.tailorSubTab === "ready") {
    void loadTailorResumes({ filters: next });
  }
}

function patchListFilterText(key, value) {
  if (!listFilterDraft) listFilterDraft = { ...getListFilters() };
  listFilterDraft[key] = value;
  if (listFilterDebounce) clearTimeout(listFilterDebounce);
  listFilterDebounce = setTimeout(() => {
    const active = document.activeElement;
    const restoreKey =
      (active && active.getAttribute && active.getAttribute("data-filter-key")) || null;
    const selStart = active && active.selectionStart;
    const selEnd = active && active.selectionEnd;
    const next = { ...getListFilters() };
    listFilterDraft = null;
    listFilterDebounce = null;
    setState({ listFilters: next, pageByTab: resetListPages() });
    if (state.homeTab === "tailor" && state.tailorSubTab === "ready") {
      void loadTailorResumes({ filters: next });
    }
    if (!restoreKey) return;
    requestAnimationFrame(() => {
      const input = document.querySelector(`.list-filter-input[data-filter-key="${restoreKey}"]`);
      if (!input) return;
      input.focus();
      if (typeof selStart === "number" && typeof selEnd === "number") {
        try {
          input.setSelectionRange(selStart, selEnd);
        } catch (_e) {
          /* ignore */
        }
      }
    });
  }, 220);
}

function flushListFilterText() {
  if (listFilterDebounce) {
    clearTimeout(listFilterDebounce);
    listFilterDebounce = null;
  }
  if (!listFilterDraft) return;
  const next = { ...getListFilters() };
  listFilterDraft = null;
  setState({ listFilters: next, pageByTab: resetListPages() });
  if (state.homeTab === "tailor" && state.tailorSubTab === "ready") {
    void loadTailorResumes({ filters: next });
  }
}

function clearListFilters() {
  listFilterDraft = null;
  if (listFilterDebounce) {
    clearTimeout(listFilterDebounce);
    listFilterDebounce = null;
  }
  setState({ listFilters: { ...DEFAULT_LIST_FILTERS }, pageByTab: resetListPages() });
  if (state.homeTab === "tailor" && state.tailorSubTab === "ready") {
    void loadTailorResumes({ filters: { ...DEFAULT_LIST_FILTERS } });
  }
}

function listFiltersAreActive(f = getListFilters()) {
  return !!(
    (f.title && f.title.trim()) ||
    (f.company && f.company.trim()) ||
    f.workMode ||
    f.source ||
    (f.sort && f.sort !== "created_at") ||
    (f.order && f.order !== "desc")
  );
}

function compareJobCards(a, b, key) {
  if (key === "match_score") {
    const as = a.score == null ? -1 : Number(a.score);
    const bs = b.score == null ? -1 : Number(b.score);
    return as - bs;
  }
  if (key === "posted_date" || key === "created_at") {
    const at = Date.parse(a.postedAt || a.createdAt || 0) || 0;
    const bt = Date.parse(b.postedAt || b.createdAt || 0) || 0;
    return at - bt;
  }
  if (key === "source") return String(a.source || "").localeCompare(String(b.source || ""));
  if (key === "company") return String(a.company || "").localeCompare(String(b.company || ""));
  if (key === "title") return String(a.title || "").localeCompare(String(b.title || ""));
  return 0;
}

function filterAndRankCards(cards) {
  const f = getListFilters();
  const titleQ = (f.title || "").trim().toLowerCase();
  const companyQ = (f.company || "").trim().toLowerCase();
  const wantMode = (f.workMode || "").trim().toLowerCase();
  const wantSource = (f.source || "").trim().toLowerCase();
  let out = (cards || []).filter((c) => {
    if (titleQ && !String(c.title || "").toLowerCase().includes(titleQ)) return false;
    if (companyQ && !String(c.company || "").toLowerCase().includes(companyQ)) return false;
    if (wantMode && normalizeCardWorkMode(c.workMode) !== wantMode) return false;
    if (wantSource && String(c.source || "").toLowerCase() !== wantSource) return false;
    return true;
  });
  const dir = f.order === "asc" ? 1 : -1;
  const sortKey = f.sort || "created_at";
  out = out.slice().sort((a, b) => {
    const primary = compareJobCards(a, b, sortKey) * dir;
    if (primary !== 0) return primary;
    // Stable tie-break: newer first, then title.
    const tie = compareJobCards(a, b, "created_at") * -1;
    if (tie !== 0) return tie;
    return compareJobCards(a, b, "title");
  });
  return out;
}

function renderSelect(opts) {
  const { value, options, onChange, className, title } = opts;
  return el(
    "select",
    {
      class: className || "list-filter-select",
      title: title || "",
      onchange: (e) => onChange(e.target.value),
    },
    options.map((o) =>
      el(
        "option",
        o.value === value ? { value: o.value, selected: "selected" } : { value: o.value },
        o.label
      )
    )
  );
}

function renderListFilterBar(totalBefore, totalAfter, { resumeMode = false } = {}) {
  const f = getListFilters();
  const active = listFiltersAreActive(f);
  const platformOpts = resumeMode
    ? [
        { value: "", label: "All sources" },
        { value: "tailored", label: "AI / manual JD" },
        { value: "job_workflow", label: "Platform job" },
        { value: "manual", label: "Library" },
      ]
    : [
        { value: "", label: "All platforms" },
        ...Object.keys(SOURCE_META).map((k) => ({ value: k, label: SOURCE_META[k].label })),
      ];
  const workOpts = [
    { value: "", label: "Any work mode" },
    { value: "remote", label: "Remote" },
    { value: "hybrid", label: "Hybrid" },
    { value: "onsite", label: "On-site" },
  ];
  const sortOpts = resumeMode
    ? [
        { value: "created_at", label: "Date updated" },
        { value: "posted_date", label: "Date created" },
        { value: "title", label: "Title" },
        { value: "company", label: "Company" },
        { value: "source", label: "Source" },
      ]
    : [
        { value: "created_at", label: "Date added" },
        { value: "posted_date", label: "Posted date" },
        { value: "match_score", label: "Match score" },
        { value: "source", label: "Platform" },
        { value: "title", label: "Title" },
        { value: "company", label: "Company" },
      ];

  const titleInput = el("input", {
    type: "search",
    class: "list-filter-input",
    "data-filter-key": "title",
    placeholder: resumeMode ? "Search role / title…" : "Search title…",
    value: f.title || "",
    autocomplete: "off",
    spellcheck: "false",
  });
  titleInput.addEventListener("input", (e) => patchListFilterText("title", e.target.value));
  titleInput.addEventListener("change", () => flushListFilterText());
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      flushListFilterText();
    }
  });

  const companyInput = el("input", {
    type: "search",
    class: "list-filter-input",
    "data-filter-key": "company",
    placeholder: "Company…",
    value: f.company || "",
    autocomplete: "off",
    spellcheck: "false",
  });
  companyInput.addEventListener("input", (e) => patchListFilterText("company", e.target.value));
  companyInput.addEventListener("change", () => flushListFilterText());
  companyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      flushListFilterText();
    }
  });

  const fields = [
    el("div", { class: "list-filter-field list-filter-search" }, [
      el("label", { class: "list-filter-label" }, resumeMode ? "Role" : "Title"),
      titleInput,
    ]),
    el("div", { class: "list-filter-field list-filter-search" }, [
      el("label", { class: "list-filter-label" }, "Company"),
      companyInput,
    ]),
  ];
  if (!resumeMode) {
    fields.push(
      el("div", { class: "list-filter-field" }, [
        el("label", { class: "list-filter-label" }, "Work mode"),
        renderSelect({
          value: f.workMode || "",
          options: workOpts,
          title: "Filter by remote / hybrid / on-site",
          onChange: (v) => commitListFilters({ workMode: v }),
        }),
      ])
    );
  }
  fields.push(
    el("div", { class: "list-filter-field" }, [
      el("label", { class: "list-filter-label" }, resumeMode ? "Source" : "Platform"),
      renderSelect({
        value: f.source || "",
        options: platformOpts,
        title: resumeMode ? "Filter by resume source" : "Filter by ATS / job board",
        onChange: (v) => commitListFilters({ source: v }),
      }),
    ]),
    el("div", { class: "list-filter-field" }, [
      el("label", { class: "list-filter-label" }, "Rank by"),
      renderSelect({
        value: f.sort || "created_at",
        options: sortOpts,
        title: resumeMode ? "Sort resumes" : "Sort by posted date, platform, score…",
        onChange: (v) => commitListFilters({ sort: v }),
      }),
    ]),
    el("div", { class: "list-filter-field list-filter-order" }, [
      el("label", { class: "list-filter-label" }, "Order"),
      el(
        "button",
        {
          type: "button",
          class: "list-filter-order-btn" + (f.order === "asc" ? " is-asc" : ""),
          title:
            f.order === "asc"
              ? "Ascending — click for descending"
              : "Descending — click for ascending",
          onclick: () => commitListFilters({ order: f.order === "asc" ? "desc" : "asc" }),
        },
        f.order === "asc" ? "↑ Asc" : "↓ Desc"
      ),
    ])
  );

  return el("div", { class: "list-filters" + (active ? " is-active" : "") }, [
    el("div", { class: "list-filters-head" }, [
      el("div", { class: "list-filters-title" }, resumeMode ? "Search & rank resumes" : "Filter & rank"),
      el(
        "div",
        { class: "list-filters-meta muted small" },
        totalBefore === totalAfter
          ? `${totalAfter} ${resumeMode ? "resume" : "job"}${totalAfter === 1 ? "" : "s"}`
          : `${totalAfter} of ${totalBefore}`
      ),
      active
        ? el(
            "button",
            {
              type: "button",
              class: "btn link list-filters-clear",
              onclick: () => clearListFilters(),
            },
            "Clear"
          )
        : null,
    ]),
    el("div", { class: "list-filters-grid" + (resumeMode ? " resume-mode" : "") }, fields),
  ]);
}

/** Filter bar + paginated list for every job list page. */
function renderFilteredJobList(tabId, cards, emptyMsg, { prepend, bindContext = true } = {}) {
  const all = cards || [];
  let filtered = filterAndRankCards(all);
  if (bindContext) filtered = bindApplyListContext(tabId, filtered);
  const empty =
    all.length && !filtered.length ? "No jobs match these filters." : emptyMsg;
  const section = el("div", { class: "filtered-job-list tab-panel" });
  if (prepend) {
    for (const node of [].concat(prepend)) {
      if (node) section.appendChild(node);
    }
  }
  section.appendChild(renderListFilterBar(all.length, filtered.length));
  section.appendChild(jobListSection(tabId, filtered, empty));
  return section;
}

function renderActiveTab() {
  const scoreHint =
    state.minScore > 0 ? `No jobs at or above match score ${state.minScore}.` : null;
  const bestFloor = state.BEST_MATCH_SCORE || 75;
  switch (state.homeTab) {
    case "progress":
      return renderFilteredJobList(
        "progress",
        state.sessions.map((s) => {
          const snap = s.job_snapshot || {};
          return {
            jobId: s.job_id,
            title: s.job_title || snap.title || "(untitled job)",
            company: s.company || snap.company,
            score: snap.match_score,
            source:
              String(snap.source || sourceFromUrl(s.job_url || snap.url) || "")
                .toLowerCase()
                .trim() || null,
            workMode: normalizeCardWorkMode(snap.work_mode || snap.remote_policy || null),
            postedAt: snap.posted_date || s.created_at || null,
            createdAt: s.created_at || null,
            chips: sessionChips(s, snap),
            onClick: () => openJob(s.job_id, { redirect: true }),
          };
        }),
        "No applications in progress yet."
      );
    case "today":
      return renderFilteredJobList(
        "today",
        todayJobsForSubTab().map((j) => jobToCard(j)),
        todayEmptyMessage(),
        { prepend: renderTodaySubTabs() }
      );
    case "all":
      return renderFilteredJobList(
        "all",
        state.queue.map((j) => jobToCard(j)),
        scoreHint || "No jobs in the system yet.",
        { prepend: renderMinScoreControl() }
      );
    case "ready":
      return renderFilteredJobList(
        "ready",
        (state.readyQueue || []).map((j) => jobToCard(j)),
        scoreHint || "No ready-to-apply jobs yet (tailored resume ready, not yet applied).",
        { prepend: renderMinScoreControl() }
      );
    case "best":
      return renderFilteredJobList(
        "best",
        (state.bestQueue || []).map((j) => jobToCard(j)),
        `No jobs with match score ≥ ${bestFloor}.`,
        { prepend: renderMinScoreControl() }
      );
    case "remote":
      return renderFilteredJobList(
        "remote",
        (state.remoteQueue || []).map((j) => jobToCard(j)),
        scoreHint || "No remote jobs yet.",
        { prepend: renderMinScoreControl() }
      );
    case "mine":
      return renderFilteredJobList(
        "mine",
        (state.mineQueue || []).map((j) => jobToCard(j)),
        "You have not posted any jobs yet."
      );
    case "applied":
    case "tailor":
      return renderTailorResume();
    case "stats":
      return renderStatistics();
    case "settings":
      return renderSettings();
    default:
      return renderFilteredJobList(
        "all",
        state.queue.map((j) => jobToCard(j)),
        scoreHint || "No jobs in the system yet.",
        { prepend: renderMinScoreControl() }
      );
  }
}

/** All dashboard jobs the Tailor page considers (today + all, deduped). */
function tailorJobPool() {
  const seen = new Set();
  const out = [];
  for (const j of [...(state.todayQueue || []), ...(state.queue || [])]) {
    if (!j || !j.id || seen.has(j.id)) continue;
    seen.add(j.id);
    out.push(j);
  }
  return out;
}

function _cg(j) {
  return String((j && j.content_generation_status) || "").toLowerCase();
}

function _docx(j) {
  return String((j && (j.resume_build_status || j.resume_docx_status)) || "").toLowerCase();
}

function _pdf(j) {
  return String((j && j.resume_pdf_status) || "").toLowerCase();
}

/**
 * Job has a tailored resume (Phase-B content done, or DOCX/PDF already built).
 * This drives the Tailor → Generated tab.
 */
function jobHasTailoredResume(j) {
  if (!j) return false;
  if (_cg(j) === "completed") return true;
  return _pdf(j) === "completed" || _docx(j) === "completed";
}

/** Alias used elsewhere for "resume pipeline finished enough to treat as ready". */
function jobResumeReady(j) {
  return jobHasTailoredResume(j);
}

/**
 * True mid-pipeline (queued/processing) — leftover pending files after
 * failed/skipped content do NOT count as in-flight.
 */
function jobResumeInProgress(j) {
  if (!j || jobHasTailoredResume(j)) return false;
  const cg = _cg(j);
  if (cg === "failed" || cg === "skipped") return false;
  if (cg === "pending" || cg === "processing") return true;
  return _docx(j) === "processing" || _pdf(j) === "processing";
}

/** Failed / skipped tailor attempts that need a retry. */
function jobResumeFailed(j) {
  if (!j || jobHasTailoredResume(j) || jobResumeInProgress(j)) return false;
  const cg = _cg(j);
  if (cg === "failed" || cg === "skipped") return true;
  const docx = _docx(j);
  const pdf = _pdf(j);
  return docx === "failed" || pdf === "failed";
}

/**
 * Tailor → In progress: every job that does NOT yet have a tailored resume
 * (never started, queued, generating, or failed — excluding applied).
 */
function tailorInProgressJobs() {
  return tailorJobPool().filter((j) => !j.applied_at && !jobHasTailoredResume(j));
}

/** Tailor → Generated: every job that already has a tailored resume. */
function tailorGeneratedJobs() {
  return tailorJobPool().filter((j) => jobHasTailoredResume(j));
}

/** Jobs that still need a tailor kickoff (idle — not running, not failed). */
function tailorCandidateJobs() {
  return tailorInProgressJobs().filter(
    (j) => !jobResumeInProgress(j) && !jobResumeFailed(j)
  );
}

function tailorMakingJobs() {
  return tailorJobPool().filter((j) => !j.applied_at && jobResumeInProgress(j));
}

function tailorFailedJobs() {
  return tailorJobPool().filter((j) => !j.applied_at && jobResumeFailed(j));
}

function tailorReadyJobs() {
  return tailorGeneratedJobs();
}

function resumeProgressLabel(j) {
  const cg = _cg(j);
  const docx = _docx(j);
  const pdf = _pdf(j);
  if (cg === "failed") return "Content failed — tap to retry";
  if (cg === "skipped") return "Tailoring skipped — tap to retry";
  if (cg === "processing") return "Generating tailored content…";
  if (cg === "pending") return "Queued for tailoring…";
  if (cg === "completed") {
    if (docx === "processing" || pdf === "processing") return "Building DOCX / PDF…";
    if (docx === "pending" || pdf === "pending") return "Queued for file build…";
    if (docx === "failed" || pdf === "failed") return "File build failed — tap to retry";
    return "Tailored resume ready";
  }
  if (docx === "processing" || pdf === "processing") return "Building DOCX / PDF…";
  if (docx === "failed" || pdf === "failed") return "File build failed — tap to retry";
  if (!cg) return "Tap to tailor";
  return "Needs tailored resume";
}

function tailorJobStatusChip(j) {
  if (jobResumeFailed(j)) {
    return { label: resumeProgressLabel(j), tone: "danger", dot: true };
  }
  if (jobResumeInProgress(j)) {
    return { label: resumeProgressLabel(j), tone: "warn", dot: true };
  }
  if (jobHasTailoredResume(j)) {
    const chips = [{ label: "Tailored", tone: "ok", dot: true }];
    if (_pdf(j) === "completed") chips.push({ label: "Resume", tone: "ok", dot: true });
    if (String(j.cover_letter_pdf_status || "").toLowerCase() === "completed") {
      chips.push({ label: "Cover letter", tone: "ok", dot: true });
    } else if (_docx(j) === "processing" || _pdf(j) === "processing" || _pdf(j) === "pending") {
      chips.push({ label: "Building files…", tone: "warn", dot: true });
    }
    return chips;
  }
  return { label: "Tap to tailor", tone: "primary", dot: true };
}

function tailorInProgressCard(j) {
  const onClick = jobResumeInProgress(j)
    ? () => openJob(j.id, { redirect: true })
    : () => void startJobTailor(j);
  const card = jobToCard(j, onClick);
  const status = tailorJobStatusChip(j);
  const statusChips = Array.isArray(status) ? status : [status];
  return {
    ...card,
    chips: [
      ...(card.chips || []).filter((c) => c && c.label !== "Resume" && c.label !== "Cover letter"),
      ...statusChips,
    ],
  };
}

function tailorDocDownloadsFromJob(j) {
  if (!j || !j.id) return null;
  return {
    jobId: j.id,
    resumePdf: _pdf(j) === "completed",
    resumeDocx: _docx(j) === "completed",
    coverPdf: String(j.cover_letter_pdf_status || "").toLowerCase() === "completed",
    coverDocx: String(j.cover_letter_docx_status || "").toLowerCase() === "completed",
  };
}

function tailorDocDownloadsFromHit(hit) {
  if (!hit || !hit.job_id) return null;
  // Library search hits only expose PDF availability flags.
  if (!hit.has_resume_pdf && !hit.has_cover_letter) return null;
  return {
    jobId: hit.job_id,
    resumePdf: !!hit.has_resume_pdf,
    resumeDocx: false,
    coverPdf: !!hit.has_cover_letter,
    coverDocx: false,
  };
}

function tailorGeneratedCard(j) {
  const card = jobToCard(j, () => void openTailoredJob(j));
  const status = tailorJobStatusChip(j);
  const statusChips = Array.isArray(status) ? status : [status];
  return {
    ...card,
    chips: [
      ...(card.chips || []).filter((c) => c && c.label !== "Resume" && c.label !== "Cover letter"),
      ...statusChips,
    ],
    docDownloads: tailorDocDownloadsFromJob(j),
  };
}

async function openTailoredJob(j) {
  if (!j) return;
  try {
    if (j.resume_build_id) {
      await api.openJobBuildResume(j.resume_build_id);
      toast("Opened tailored resume in library.");
      await openResumeBuilderTab();
      return;
    }
    const readyIds = (state.readyQueue || []).map((row) => String(row.id));
    setState({ applyListContext: applyContextForTab("ready", readyIds) });
    await openJob(j.id, { redirect: true });
  } catch (err) {
    toast((err && err.message) || "Could not open tailored resume.");
  }
}

function resumeHitToCard(hit) {
  const title = hit.job_title || hit.name || "(untitled resume)";
  const sourceLabel =
    hit.source === "job_workflow"
      ? "Platform"
      : hit.source === "tailored"
        ? "AI"
        : hit.source === "manual"
          ? "Library"
          : hit.source || "Resume";
  const tone =
    hit.source === "job_workflow" ? "info" : hit.source === "tailored" ? "primary" : "ok";
  return {
    jobId: hit.job_id || hit.id,
    title,
    company: hit.company,
    score: hit.match_score != null ? hit.match_score : null,
    source: hit.source || null,
    workMode: null,
    postedAt: hit.created_at || null,
    createdAt: hit.updated_at || hit.created_at || null,
    chips: [
      { label: sourceLabel, tone, dot: true },
      hit.is_active ? { label: "Active", tone: "ok" } : null,
      hit.has_resume_pdf ? { label: "Resume", tone: "ok", dot: true } : null,
      hit.has_cover_letter ? { label: "Cover letter", tone: "ok", dot: true } : null,
      hit.content_ready === false ? { label: "Not ready", tone: "warn" } : null,
    ].filter(Boolean),
    docDownloads: tailorDocDownloadsFromHit(hit),
    onClick: () => openTailorHit(hit),
  };
}

/** Convert a dashboard job with a tailored resume into a Generated hit (for API merge). */
function dashboardJobToResumeHit(j) {
  return {
    kind: "job_build",
    id: j.resume_build_id || j.id,
    build_id: j.resume_build_id || null,
    job_id: j.id,
    name: [j.title, j.company].filter(Boolean).join(" - ") || "Job resume",
    status: "completed",
    source: "job_workflow",
    job_title: j.title || null,
    company: j.company || null,
    is_active: false,
    content_ready: true,
    has_resume_pdf: j.resume_pdf_status === "completed",
    has_cover_letter: j.cover_letter_pdf_status === "completed",
    match_score: j.match_overall_score,
    created_at: j.created_at || null,
    updated_at: j.updated_at || j.created_at || null,
  };
}

function resumeHitDedupeKey(hit) {
  const company = String(hit.company || "")
    .trim()
    .toLowerCase();
  const title = String(hit.job_title || hit.name || "")
    .trim()
    .toLowerCase();
  if (hit.job_id) return `job:${hit.job_id}`;
  if (company || title) return `meta:${company}::${title}`;
  return `id:${hit.id}`;
}

/**
 * Generated tab is job-first: every dashboard job with a tailored resume.
 * Library search only fills gaps (builds missing from the loaded queue pages)
 * plus manual/AI library resumes that aren't tied to a platform job.
 */
async function loadTailorResumes({ filters } = {}) {
  if (!state.user) return;
  const f = filters || getListFilters();
  setState({ tailorHitsLoading: true });
  try {
    const companyQ = (f.company || "").trim();
    const titleQ = (f.title || "").trim();

    // Primary source: dashboard jobs that already have a tailored resume.
    let jobs = tailorGeneratedJobs();
    if (companyQ) {
      const q = companyQ.toLowerCase();
      jobs = jobs.filter((j) => String(j.company || "").toLowerCase().includes(q));
    }
    if (titleQ) {
      const q = titleQ.toLowerCase();
      jobs = jobs.filter((j) => String(j.title || "").toLowerCase().includes(q));
    }

    const jobHits = jobs.map(dashboardJobToResumeHit);
    const seen = new Set(jobHits.map(resumeHitDedupeKey));

    // Secondary: library/search so we don't miss builds outside the current queue pages.
    let searchHits = [];
    try {
      const res = await api.searchResumeLibrary({
        company: companyQ || undefined,
        job_title: titleQ || undefined,
        limit: 200,
      });
      searchHits = (res && res.resumes) || [];
    } catch (_e) {
      /* dashboard jobs still render */
    }

    for (const hit of searchHits) {
      const key = resumeHitDedupeKey(hit);
      if (seen.has(key)) continue;
      // Prefer job_workflow / tailored; skip empty junk.
      if (hit.kind === "job_build" || hit.source === "job_workflow") {
        // Only keep search job builds that actually look content-ready.
        if (hit.content_ready === false) continue;
        seen.add(key);
        jobHits.push(hit);
      } else if (hit.source === "tailored" || hit.source === "manual") {
        seen.add(key);
        jobHits.push(hit);
      }
    }

    let hits = jobHits;
    if (f.source) {
      hits = hits.filter((h) => String(h.source || "").toLowerCase() === f.source);
    }
    const dir = f.order === "asc" ? 1 : -1;
    const sortKey = f.sort || "created_at";
    hits = hits.slice().sort((a, b) => {
      const cardA = resumeHitToCard(a);
      const cardB = resumeHitToCard(b);
      const primary = compareJobCards(cardA, cardB, sortKey) * dir;
      if (primary !== 0) return primary;
      return compareJobCards(cardA, cardB, "created_at") * -1;
    });
    setState({ tailorHits: hits, tailorHitsLoading: false });
  } catch (err) {
    setState({
      tailorHitsLoading: false,
      error: (err && err.message) || "Failed to load tailored resumes.",
    });
  }
}

function patchTailorRun(id, patch) {
  const runs = (state.tailorRuns || []).map((r) => (r.id === id ? { ...r, ...patch } : r));
  setState({ tailorRuns: runs });
}

async function startManualTailor() {
  const jd = (tailorJdDraft || "").trim();
  if (jd.length < 80) {
    toast("Paste a fuller job description (at least a short posting).");
    return;
  }
  if ((state.tailorRuns || []).some((r) => r.kind === "manual" && r.status === "running")) {
    toast("A manual tailor is already running.");
    return;
  }
  const runId = `manual-${Date.now()}`;
  const run = {
    id: runId,
    kind: "manual",
    title: "Manual job description",
    company: null,
    stage: "routing",
    label: "Starting…",
    status: "running",
    error: null,
    resumeId: null,
  };
  setState({
    tailorRuns: [run, ...(state.tailorRuns || [])],
    tailorSubTab: "making",
  });
  try {
    const result = await api.streamResumeAiChat(
      [{ role: "user", content: jd }],
      null,
      {
        onStage: (ev) => {
          patchTailorRun(runId, {
            stage: ev.stage,
            label: ev.label || ev.stage,
          });
        },
      }
    );
    if (result.action !== "tailored" || !result.content) {
      patchTailorRun(runId, {
        status: "error",
        error: result.reply || "AI did not return tailored content. Try again.",
        label: "No tailored content",
      });
      return;
    }
    patchTailorRun(runId, {
      label: "Saving to library…",
      title: result.job_title || "Tailored resume",
      company: result.company || null,
    });
    const saved = await api.saveAiTailoredResume({
      content: result.content,
      job_title: result.job_title || null,
      company: result.company || null,
      activate: true,
    });
    const resume = saved && saved.resume;
    patchTailorRun(runId, {
      status: "done",
      label: "Saved to library",
      stage: "done",
      title: (resume && resume.job_title) || result.job_title || "Tailored resume",
      company: (resume && resume.company) || result.company || null,
      resumeId: resume && resume.id,
    });
    tailorJdDraft = "";
    toast("Tailored resume saved.");
    setState({ tailorSubTab: "ready" });
    await loadTailorResumes();
  } catch (err) {
    if (err && err.name === "AbortError") return;
    patchTailorRun(runId, {
      status: "error",
      error: (err && err.message) || "Tailor failed.",
      label: "Failed",
    });
    toast((err && err.message) || "Tailor failed.");
  }
}

async function startJobTailor(job) {
  if (!job || !job.id) return;
  if (jobResumeInProgress(job)) {
    toast("Tailoring already in progress for this job.");
    setState({ tailorSubTab: "making" });
    return;
  }
  const runId = `job-${job.id}`;
  const existing = (state.tailorRuns || []).find((r) => r.id === runId && r.status === "running");
  if (existing) {
    setState({ tailorSubTab: "making" });
    return;
  }
  setState({
    tailorSubTab: "making",
    tailorRuns: [
      {
        id: runId,
        kind: "job",
        jobId: job.id,
        title: job.title || "(untitled job)",
        company: job.company || null,
        stage: "queue",
        label: "Queuing…",
        status: "running",
        error: null,
      },
      ...(state.tailorRuns || []).filter((r) => r.id !== runId),
    ],
  });
  try {
    await api.triggerResumeBuild(job.id);
    patchTailorRun(runId, {
      label: "Queued — generating tailored content…",
      stage: "queued",
    });
    toast("Tailored resume started for this job.");
    void loadQueue({ silent: true });
  } catch (err) {
    patchTailorRun(runId, {
      status: "error",
      error: (err && err.message) || "Could not start resume build.",
      label: "Failed to queue",
    });
    toast((err && err.message) || "Could not start resume build.");
  }
}

async function openTailorHit(hit) {
  if (!hit) return;
  try {
    if (hit.kind === "job_build" || hit.source === "job_workflow") {
      const buildId = hit.build_id || (hit.kind === "job_build" ? hit.id : null);
      if (buildId) {
        await api.openJobBuildResume(buildId);
        toast("Opened job resume in library.");
      } else if (hit.job_id) {
        await openJob(hit.job_id, { redirect: true });
        return;
      } else {
        throw new Error("Missing resume build id.");
      }
    } else {
      await api.activateResume(hit.id);
      toast("Activated resume in library.");
    }
    await openResumeBuilderTab();
    await loadTailorResumes();
  } catch (err) {
    toast((err && err.message) || "Could not open resume.");
  }
}

async function openResumeBuilderTab() {
  try {
    const base = await store.getBackendUrl();
    const origin = String(base || "").replace(/\/$/, "");
    if (!origin) return;
    const url = `${origin}/resume-builder`;
    await chrome.tabs.create({ url, active: true });
  } catch (_e) {
    /* best-effort */
  }
}

function renderTailorJdComposer() {
  const running = (state.tailorRuns || []).some((r) => r.kind === "manual" && r.status === "running");
  const area = el("textarea", {
    class: "tailor-jd-input",
    rows: "6",
    placeholder:
      "Paste a job description here…\n\nSame OneClick AI flow as the Resume Builder — we analyze, tailor, and save to your library.",
    value: tailorJdDraft || "",
  });
  area.addEventListener("input", (e) => {
    tailorJdDraft = e.target.value;
  });
  return el("div", { class: "tailor-composer" }, [
    el("div", { class: "tailor-composer-head" }, [
      el("div", { class: "tailor-composer-title" }, "Paste job description"),
      el(
        "p",
        { class: "muted small tailor-composer-sub" },
        "Manual JD → AI tailor → saved with company & title, searchable like the builder."
      ),
    ]),
    area,
    el("div", { class: "tailor-composer-actions" }, [
      el(
        "button",
        {
          type: "button",
          class: "btn primary",
          disabled: running,
          onclick: () => void startManualTailor(),
        },
        running ? "Tailoring…" : "Tailor with AI"
      ),
    ]),
  ]);
}

function renderTailorSubTabs(makingCount, readyCount) {
  const tab = (id, label, count) =>
    el(
      "button",
      {
        type: "button",
        class: "sub-tab" + (state.tailorSubTab === id ? " active" : ""),
        onclick: () => {
          setState({ tailorSubTab: id, pageByTab: { ...state.pageByTab, tailor: 1 } });
          if (id === "ready") void loadTailorResumes();
        },
      },
      [
        el("span", {}, label),
        el("span", { class: "sub-tab-count" }, String(count)),
      ]
    );
  return el("div", { class: "sub-tabs tailor-sub-tabs" }, [
    tab("making", "In progress", makingCount),
    tab("ready", "Generated", readyCount),
  ]);
}

function renderTailorProgressCard(run) {
  const tone =
    run.status === "done" ? "ok" : run.status === "error" ? "danger" : "primary";
  return el("div", { class: "tailor-progress-card tone-" + tone }, [
    el("div", { class: "tailor-progress-top" }, [
      el("div", { class: "tailor-progress-title" }, run.title || "Tailoring…"),
      el(
        "span",
        { class: "tailor-progress-badge" },
        run.kind === "manual" ? "Manual JD" : "Platform"
      ),
    ]),
    run.company
      ? el("div", { class: "muted small tailor-progress-company" }, run.company)
      : null,
    el("div", { class: "tailor-progress-status" }, [
      run.status === "running" ? el("span", { class: "spinner tiny" }) : null,
      el("span", {}, run.label || run.stage || run.status),
    ]),
    run.error ? el("div", { class: "tailor-progress-error" }, run.error) : null,
    run.status === "done" && run.resumeId
      ? el(
          "button",
          {
            type: "button",
            class: "btn link small",
            onclick: () =>
              openTailorHit({
                kind: "library",
                id: run.resumeId,
                content_ready: true,
              }),
          },
          "Open in Resume Builder"
        )
      : null,
  ]);
}

function renderTailorMakingPanel() {
  const runs = state.tailorRuns || [];
  const jobs = tailorInProgressJobs();
  // Active pipeline first, then failed (retry), then idle (tap to start).
  const sorted = jobs.slice().sort((a, b) => {
    const rank = (j) => {
      if (jobResumeInProgress(j)) return 0;
      if (jobResumeFailed(j)) return 1;
      return 2;
    };
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (Number(b.match_overall_score) || 0) - (Number(a.match_overall_score) || 0);
  });
  const cards = sorted.map(tailorInProgressCard);
  const filtered = filterAndRankCards(cards);

  const section = el("div", { class: "tab-panel tailor-making" });

  const activeRuns = runs.filter((r) => r.status === "running");
  const otherRuns = runs.filter((r) => r.status !== "running").slice(0, 8);
  if (activeRuns.length || otherRuns.length) {
    section.appendChild(el("div", { class: "tailor-section-label" }, "Your requests"));
    const list = el("div", { class: "tailor-progress-list" });
    [...activeRuns, ...otherRuns]
      .slice(0, 12)
      .forEach((r) => list.appendChild(renderTailorProgressCard(r)));
    section.appendChild(list);
  }

  section.appendChild(
    el("div", { class: "tailor-section-label" }, "Jobs without a tailored resume")
  );
  section.appendChild(
    el(
      "p",
      { class: "muted small tailor-section-hint" },
      "These jobs are not ready yet — tailoring has not finished (or has not started)."
    )
  );
  section.appendChild(renderListFilterBar(cards.length, filtered.length));
  section.appendChild(
    jobListSection(
      "tailor",
      filtered,
      cards.length
        ? "No jobs match these filters."
        : "Every loaded job already has a tailored resume. Paste a JD above for a manual tailor."
    )
  );
  return section;
}

function renderTailorReadyPanel() {
  // Primary: dashboard jobs that already have tailored content / files.
  const jobs = tailorGeneratedJobs();
  const jobIds = new Set(jobs.map((j) => j.id));
  const jobCards = jobs.map(tailorGeneratedCard);

  // Extras from library search (manual/AI resumes, or builds missing from queue pages).
  const extraHits = (state.tailorHits || []).filter((h) => {
    if (h.job_id && jobIds.has(h.job_id)) return false;
    if (h.kind === "job_build" || h.source === "job_workflow") return true;
    return h.source === "tailored" || h.source === "manual";
  });
  const extraCards = extraHits.map(resumeHitToCard);
  const allCards = [...jobCards, ...extraCards];
  const filtered = filterAndRankCards(allCards);

  const section = el("div", { class: "tab-panel" });
  section.appendChild(
    el("div", { class: "tailor-section-label" }, "Jobs with a tailored resume")
  );
  section.appendChild(renderListFilterBar(allCards.length, filtered.length, { resumeMode: true }));
  if (state.tailorHitsLoading && !allCards.length) {
    section.appendChild(renderSkeletonList(4));
    return section;
  }
  section.appendChild(
    jobListSection(
      "tailor",
      filtered,
      allCards.length
        ? "No resumes match these filters."
        : "No tailored resumes yet. Start one from In progress, or paste a JD above."
    )
  );
  return section;
}

function renderTailorResume() {
  const inProgressJobs = tailorInProgressJobs();
  const generatedJobs = tailorGeneratedJobs();
  const activeRuns = (state.tailorRuns || []).filter((r) => r.status === "running").length;
  const makingCount = inProgressJobs.length + activeRuns;
  const readyCount = generatedJobs.length + (state.tailorHits || []).filter((h) => {
    if (h.job_id && generatedJobs.some((j) => j.id === h.job_id)) return false;
    return (
      h.kind === "job_build" ||
      h.source === "job_workflow" ||
      h.source === "tailored" ||
      h.source === "manual"
    );
  }).length;

  const wrap = el("div", { class: "tab-panel tailor-page" });
  wrap.appendChild(renderTailorJdComposer());
  wrap.appendChild(renderTailorSubTabs(makingCount, readyCount));

  if (state.tailorSubTab === "ready") {
    wrap.appendChild(renderTailorReadyPanel());
  } else {
    wrap.appendChild(renderTailorMakingPanel());
  }
  return wrap;
}

function renderStatistics() {
  const period = state.statsPeriod || "week";
  const progress = state.statsProgress || (period === "week" ? state.weeklyProgress : null);
  const series = (progress && progress.series) || [];
  const totals = (progress && progress.totals) || { posted: 0, recommended: 0, applied: 0 };
  const minScore = progress && progress.min_match_score != null ? progress.min_match_score : null;
  const ss = state.scraperStats || {};
  const c = state.dashboardCounts || {};
  const loading = !!(state.statsLoading || state.queueLoading);

  const posted = totals.posted || 0;
  const recommended = totals.recommended || 0;
  const applied = totals.applied || 0;
  const applyRate = posted > 0 ? Math.round((applied / posted) * 100) : 0;
  const recRate = posted > 0 ? Math.round((recommended / posted) * 100) : 0;
  const closeRate = recommended > 0 ? Math.round((applied / recommended) * 100) : 0;

  const totalJobs = ss.total_jobs != null ? ss.total_jobs : c.all || state.queue.length || 0;
  const remote = ss.total_remote || 0;
  const remotePct = totalJobs > 0 ? Math.round((remote / totalJobs) * 100) : 0;
  const ready = ss.ready_jobs || 0;
  const extracted = ss.extracted_jobs || 0;
  const sources = (ss.sources || []).slice(0, 5);
  const maxSource = Math.max(1, ...sources.map((s) => Number(s.count) || 0));

  const bestDay = series.reduce(
    (best, d) => {
      const score = (Number(d.applied) || 0) * 3 + (Number(d.recommended) || 0);
      if (!best || score > best.score) return { ...d, score };
      return best;
    },
    null
  );

  const periodMeta = {
    day: { title: "Today", sub: "Last 24 hours in your timezone", days: 1 },
    week: { title: "This week", sub: "Last 7 days", days: 7 },
    month: { title: "This month", sub: "Last 30 days", days: 30 },
  }[period];

  const wrap = el("div", { class: "stats-page" });

  // Period switcher
  wrap.appendChild(
    el("div", { class: "stats-period-bar" }, [
      el("div", { class: "stats-period-copy" }, [
        el("div", { class: "stats-period-title" }, periodMeta.title),
        el("div", { class: "muted small" }, periodMeta.sub),
      ]),
      el(
        "div",
        { class: "stats-period-tabs", role: "tablist", "aria-label": "Stats period" },
        ["day", "week", "month"].map((id) =>
          el(
            "button",
            {
              type: "button",
              role: "tab",
              "aria-selected": period === id ? "true" : "false",
              class: "stats-period-tab" + (period === id ? " is-active" : ""),
              onclick: () => {
                setState({ statsPeriod: id });
                void loadStatsPeriod(id);
              },
            },
            id === "day" ? "Day" : id === "week" ? "Week" : "Month"
          )
        )
      ),
    ])
  );

  // Hero KPIs
  wrap.appendChild(
    el("div", { class: "stats-hero" }, [
      statsHeroCard("Posted", posted, "Jobs added", "posted", loading),
      statsHeroCard("Recommended", recommended, minScore != null ? `Match ≥ ${minScore}` : "Qualified", "recommended", loading),
      statsHeroCard("Applied", applied, "Marked applied", "applied", loading),
    ])
  );

  // Conversion strip
  wrap.appendChild(
    el("div", { class: "stats-rates" }, [
      statsRateCard("Recommend rate", recRate, `${recommended} of ${posted} posted`),
      statsRateCard("Apply rate", applyRate, `${applied} of ${posted} posted`),
      statsRateCard("Close rate", closeRate, `${applied} of ${recommended} recommended`),
    ])
  );

  // Chart
  const chartCard = el("div", { class: "stats-card-block" });
  chartCard.appendChild(
    el("div", { class: "stats-card-block-head" }, [
      el("div", { class: "stats-card-block-title" }, "Activity"),
      el(
        "div",
        { class: "muted small" },
        loading ? "Loading…" : `${series.length} day${series.length === 1 ? "" : "s"}`
      ),
    ])
  );
  chartCard.appendChild(
    el("div", { class: "weekly-legend" }, [
      legendSwatch("posted", "Posted", posted),
      legendSwatch("recommended", "Recommended", recommended),
      legendSwatch("applied", "Applied", applied),
    ])
  );
  if (!series.length) {
    chartCard.appendChild(
      el(
        "div",
        { class: "weekly-chart-empty muted small" },
        loading ? "Loading chart…" : "No activity in this period yet."
      )
    );
  } else {
    chartCard.appendChild(buildWeeklyChartSvg(series, { tall: true, dense: series.length > 10 }));
  }
  if (bestDay && (bestDay.applied > 0 || bestDay.recommended > 0)) {
    chartCard.appendChild(
      el(
        "div",
        { class: "stats-insight muted small" },
        `Peak day: ${bestDay.date || bestDay.label} · ${bestDay.applied || 0} applied · ${bestDay.recommended || 0} recommended`
      )
    );
  }
  wrap.appendChild(chartCard);

  // Pipeline snapshot
  wrap.appendChild(
    el("div", { class: "stats-card-block" }, [
      el("div", { class: "stats-card-block-head" }, [
        el("div", { class: "stats-card-block-title" }, "Pipeline snapshot"),
        el("div", { class: "muted small" }, "Right now"),
      ]),
      el("div", { class: "stats-snap-grid" }, [
        statsSnapTile("All jobs", totalJobs, "ok"),
        statsSnapTile("Suggested", c.suggested || 0, "primary"),
        statsSnapTile("In progress", state.sessions.length, "info"),
        statsSnapTile("Applied today", c.applied_today || state.appliedQueue.length || 0, "warn"),
        statsSnapTile("Ready resumes", ready, "ok"),
        statsSnapTile("Extracted", extracted),
        statsSnapTile("Remote", `${remotePct}%`, "info"),
        statsSnapTile("From me", c.mine || state.todayCounts.mine || 0),
      ]),
    ])
  );

  // Sources
  if (sources.length) {
    const srcBlock = el("div", { class: "stats-card-block" });
    srcBlock.appendChild(
      el("div", { class: "stats-card-block-head" }, [
        el("div", { class: "stats-card-block-title" }, "Top sources"),
        el("div", { class: "muted small" }, "Inventory mix"),
      ])
    );
    const list = el("div", { class: "stats-source-list" });
    sources.forEach((s) => {
      const name = prettySource(s.source) || s.source || "Unknown";
      const count = Number(s.count) || 0;
      const pct = Math.round((count / maxSource) * 100);
      list.appendChild(
        el("div", { class: "stats-source-row" }, [
          el("div", { class: "stats-source-meta" }, [
            el("span", { class: "stats-source-name" }, name),
            el("span", { class: "stats-source-count" }, String(count)),
          ]),
          el("div", { class: "stats-source-track" }, [
            el("div", { class: "stats-source-fill", style: `width:${pct}%` }),
          ]),
        ])
      );
    });
    srcBlock.appendChild(list);
    wrap.appendChild(srcBlock);
  }

  return wrap;
}

function statsHeroCard(label, value, hint, tone, loading) {
  return el("div", { class: `stats-hero-card tone-${tone || "info"}` }, [
    el("div", { class: "stats-hero-label" }, label),
    el("div", { class: "stats-hero-value" }, loading ? "…" : String(value)),
    el("div", { class: "stats-hero-hint muted small" }, hint),
  ]);
}

function statsRateCard(label, pct, detail) {
  return el("div", { class: "stats-rate-card" }, [
    el("div", { class: "stats-rate-label" }, label),
    el("div", { class: "stats-rate-value" }, `${pct}%`),
    el("div", { class: "stats-rate-detail muted small" }, detail),
  ]);
}

function statsSnapTile(label, value, tone) {
  return el("div", { class: "stats-snap-tile" + (tone ? ` tone-${tone}` : "") }, [
    el("div", { class: "stats-snap-value" }, String(value)),
    el("div", { class: "stats-snap-label" }, label),
  ]);
}

const STATS_PERIOD_DAYS = { day: 1, week: 7, month: 30 };

async function loadStatsPeriod(period) {
  const key = STATS_PERIOD_DAYS[period] ? period : "week";
  const days = STATS_PERIOD_DAYS[key];
  setState({ statsPeriod: key, statsLoading: true });
  try {
    const timezone = localTimezone();
    const [progress, scraperStats] = await Promise.all([
      api.getWeeklyProgress({ timezone, days }).catch(() => null),
      state.scraperStats
        ? Promise.resolve(state.scraperStats)
        : api.getScraperStats({ timezone }).catch(() => null),
    ]);
    setState({
      statsProgress: progress,
      scraperStats: scraperStats || state.scraperStats,
      statsLoading: false,
      // Keep hub chart in sync when viewing week
      ...(key === "week" && progress ? { weeklyProgress: progress } : {}),
    });
  } catch (err) {
    setState({
      statsLoading: false,
      error: (err && err.message) || "Failed to load statistics.",
    });
  }
}

function renderSettings() {
  const backendHint = el("div", { class: "settings-row" }, [
    el("span", { class: "muted small" }, "Backend"),
    el("span", { class: "settings-value muted small", id: "settings-backend" }, "…"),
  ]);
  void store.getBackendUrl().then((url) => {
    const node = document.getElementById("settings-backend");
    if (node) node.textContent = url || "—";
  });

  return el("div", { class: "settings-panel" }, [
    el("div", { class: "settings-block" }, [
      el("div", { class: "settings-block-title" }, "Account"),
      el("div", { class: "settings-row" }, [
        el("span", { class: "muted small" }, "Signed in as"),
        el("span", { class: "settings-value" }, state.user ? state.user.email : "—"),
      ]),
      backendHint,
      el("div", { class: "settings-actions" }, [
        el(
          "button",
          {
            type: "button",
            class: "btn small",
            onclick: async () => {
              await syncNow();
              await loadQueue();
              toast("Synced profile & settings.");
            },
          },
          "Sync now"
        ),
        el(
          "button",
          { type: "button", class: "btn small danger", onclick: () => doLogout() },
          "Sign out"
        ),
      ]),
    ]),

    el("div", { class: "settings-block" }, [
      el("div", { class: "settings-block-title" }, "Job matching"),
      el(
        "p",
        { class: "muted small settings-hint" },
        "Filters jobs while the extension polls the dashboard. 0 shows everything (same as the web app)."
      ),
      renderMinScoreControl({ compact: false }),
      el("div", { class: "settings-presets" }, [
        settingsPreset(0, "All"),
        settingsPreset(50, "50+"),
        settingsPreset(70, "70+"),
        settingsPreset(80, "80+"),
        settingsPreset(90, "90+"),
      ]),
    ]),

    el("div", { class: "settings-block" }, [
      el("div", { class: "settings-block-title" }, "Autofill"),
      settingsToggleRow({
        title: "Auto-advance until submit",
        hint: "Workday: fill each step, fix validation, and continue to Review. You submit.",
        on: !!state.autoAdvance,
        onToggle: async () => {
          const next = !state.autoAdvance;
          await store.setAutoAdvance(next);
          setState({ autoAdvance: next });
          toast(next ? "Auto-advance on." : "Auto-advance off.");
        },
      }),
      el("div", { class: "settings-field" }, [
        el("label", { class: "settings-field-label" }, "Resume for autofill"),
        el(
          "p",
          { class: "muted small settings-hint" },
          "Use tailored content when available, or stick to your original profile."
        ),
        renderSelect({
          value: state.resumeSource === "original" ? "original" : "tailored",
          className: "settings-select",
          options: [
            { value: "tailored", label: "Tailored resume (recommended)" },
            { value: "original", label: "Original profile resume" },
          ],
          onChange: async (v) => {
            const next = await store.setResumeSource(v);
            setState({ resumeSource: next });
            toast(next === "original" ? "Using original resume." : "Using tailored resume.");
          },
        }),
      ]),
      el("div", { class: "settings-field" }, [
        el("label", { class: "settings-field-label" }, "Answer strategy"),
        el(
          "p",
          { class: "muted small settings-hint" },
          "Optional guidance for the assistant when filling open-ended questions."
        ),
        (() => {
          const area = el("textarea", {
            class: "settings-textarea",
            rows: "3",
            placeholder: "e.g. Keep answers concise, emphasize React and distributed systems…",
            value: state.answerStrategy || "",
          });
          area.addEventListener("change", async (e) => {
            const next = await store.setAnswerStrategy(e.target.value);
            setState({ answerStrategy: next });
            toast("Answer strategy saved.");
          });
          return area;
        })(),
      ]),
    ]),

    el("div", { class: "settings-block" }, [
      el("div", { class: "settings-block-title" }, "Lists"),
      el("div", { class: "settings-field" }, [
        el("label", { class: "settings-field-label" }, "Jobs per page"),
        renderSelect({
          value: String(state.pageSize || 25),
          className: "settings-select",
          options: JOBS_PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} per page` })),
          onChange: (v) => {
            applyPageSize(parseInt(v, 10) || 25);
            toast("Page size updated.");
          },
        }),
      ]),
    ]),

    el("div", { class: "settings-block" }, [
      el("div", { class: "settings-block-title" }, "Assistant"),
      el(
        "p",
        { class: "muted small settings-hint" },
        "AI provider, models, and API keys are managed in Atomspace System Settings on the dashboard — not here."
      ),
      el("div", { class: "settings-field" }, [
        el("label", { class: "settings-field-label" }, "Default chat tone"),
        renderSelect({
          value: state.style || "standard",
          className: "settings-select",
          options: STYLES.map(([v, label]) => ({ value: v, label })),
          onChange: (v) => setState({ style: v }),
        }),
      ]),
      el("div", { class: "settings-field" }, [
        el("label", { class: "settings-field-label" }, "Default answer type"),
        renderSelect({
          value: state.fieldType || "",
          className: "settings-select",
          options: FIELD_TYPES.map(([v, label]) => ({ value: v, label })),
          onChange: (v) => setState({ fieldType: v }),
        }),
      ]),
    ]),

    renderAskHotkeySettings(),
  ]);
}

function renderAskHotkeySettings() {
  const label = store.formatAskHotkey(state.askHotkey);
  const recording = !!state.askHotkeyRecording;
  const block = el("div", { class: "settings-block" }, [
    el("div", { class: "settings-block-title" }, "Ask hotkey"),
    el(
      "p",
      { class: "muted small settings-hint" },
      "On an application page, select a question (or any text), then press your hotkey. Atomspace pastes it into chat and asks the assistant automatically. Chat history clears each time you open an application."
    ),
    el("div", { class: "settings-hotkey-row" }, [
      el("div", { class: "settings-hotkey-current" }, [
        el("span", { class: "muted small" }, "Current shortcut"),
        el(
          "kbd",
          { class: "settings-hotkey-kbd" + (recording ? " is-recording" : "") },
          recording ? "Press keys…" : label
        ),
      ]),
      el("div", { class: "settings-hotkey-actions" }, [
        el(
          "button",
          {
            type: "button",
            class: "btn" + (recording ? " primary" : ""),
            onclick: () => {
              if (recording) stopAskHotkeyRecording();
              else startAskHotkeyRecording();
            },
          },
          recording ? "Cancel" : "Change"
        ),
        el(
          "button",
          {
            type: "button",
            class: "btn link small",
            onclick: () => {
              if (!recording) void resetAskHotkey();
            },
          },
          "Reset"
        ),
      ]),
    ]),
    recording
      ? el(
          "p",
          { class: "muted small settings-hint" },
          "Hold Ctrl, Alt/Option, or ⌘/Win, then press a key. Esc cancels."
        )
      : null,
  ]);
  return block;
}

let askHotkeyRecordHandler = null;

function stopAskHotkeyRecording() {
  if (askHotkeyRecordHandler) {
    window.removeEventListener("keydown", askHotkeyRecordHandler, true);
    askHotkeyRecordHandler = null;
  }
  if (state.askHotkeyRecording) setState({ askHotkeyRecording: false });
}

function startAskHotkeyRecording() {
  stopAskHotkeyRecording();
  setState({ askHotkeyRecording: true });
  askHotkeyRecordHandler = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stopAskHotkeyRecording();
      toast("Hotkey change cancelled.");
      return;
    }
    const combo = store.askHotkeyFromKeyboardEvent(e);
    if (!combo) return;
    e.preventDefault();
    e.stopPropagation();
    void (async () => {
      const saved = await store.setAskHotkey(combo);
      stopAskHotkeyRecording();
      setState({ askHotkey: saved });
      toast(`Ask hotkey set to ${store.formatAskHotkey(saved)}.`);
      // Refresh listeners on the active application tab if open.
      if (state.view === "job") {
        void ensureAskHotkeyOnActiveTab({
          requestPermission: false,
          jobUrl: state.job && state.job.url,
        });
      }
    })();
  };
  window.addEventListener("keydown", askHotkeyRecordHandler, true);
}

async function resetAskHotkey() {
  stopAskHotkeyRecording();
  const saved = await store.setAskHotkey(store.DEFAULT_ASK_HOTKEY);
  setState({ askHotkey: saved });
  toast(`Ask hotkey reset to ${store.formatAskHotkey(saved)}.`);
}

function settingsPreset(score, label) {
  const active = Number(state.minScore) === score;
  return el(
    "button",
    {
      type: "button",
      class: "settings-preset" + (active ? " is-active" : ""),
      onclick: () => void applyMinScore(score),
    },
    label
  );
}

function settingsToggleRow({ title, hint, on, onToggle }) {
  return el("div", { class: "settings-toggle-row" }, [
    el("div", { class: "settings-toggle-copy" }, [
      el("div", { class: "settings-toggle-title" }, title),
      hint ? el("p", { class: "muted small settings-hint" }, hint) : null,
    ]),
    el(
      "button",
      {
        type: "button",
        class: "switch" + (on ? " on" : ""),
        role: "switch",
        "aria-checked": on ? "true" : "false",
        title: on ? "On" : "Off",
        onclick: () => onToggle && onToggle(),
      },
      el("span", { class: "switch-knob" })
    ),
  ]);
}

// ── job-card metadata helpers ────────────────────────────────────────────────

// Per-platform branding: label, brand color, and a short monogram for the logo
// avatar. The color also tints the card background + left accent stripe so the
// source is recognizable at a glance.
const SOURCE_META = {
  linkedin: { label: "LinkedIn", color: "#0A66C2", short: "in" },
  greenhouse: { label: "Greenhouse", color: "#1F9F6E", short: "GH" },
  applytojob: { label: "ApplyToJob", color: "#13A6A6", short: "AT" },
  recruiterflow: { label: "RecruiterFlow", color: "#7C3AED", short: "RF" },
  workday: { label: "Workday", color: "#0875E1", short: "WD" },
  lever: { label: "Lever", color: "#6D6AE0", short: "LV" },
  workable: { label: "Workable", color: "#00756A", short: "WB" },
  dice: { label: "Dice", color: "#E4002B", short: "DC" },
  jobright: { label: "Jobright.ai", color: "#6C5CE7", short: "JR" },
  wellfound: { label: "Wellfound", color: "#475569", short: "WF" },
  monster: { label: "Monster", color: "#6E46AE", short: "MO" },
  ashby: { label: "Ashby", color: "#4F46E5", short: "AB" },
  smartrecruiters: { label: "SmartRecruiters", color: "#0CA0E8", short: "SR" },
  pinpoint: { label: "Pinpoint", color: "#E11D48", short: "PP" },
  breezy: { label: "Breezy", color: "#2BB573", short: "BZ" },
  manatal: { label: "Manatal", color: "#2563EB", short: "MN" },
  icims: { label: "iCIMS", color: "#F26522", short: "IC" },
};

const DEFAULT_SOURCE_META = { label: null, color: "#3a4150", short: null };

// Infer a platform from a job URL when the explicit `source` field is missing
// (e.g. in-progress sessions only carry the apply URL).
function sourceFromUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return null;
  if (u.includes("myworkdayjobs") || u.includes("workday")) return "workday";
  if (u.includes("greenhouse.io") || u.includes("boards.greenhouse")) return "greenhouse";
  if (u.includes("applytojob.com") || u.includes("resumator")) return "applytojob";
  if (u.includes("recruiterflow.com") || u.includes("rfcareers.")) return "recruiterflow";
  if (u.includes("lever.co")) return "lever";
  if (u.includes("workable.com")) return "workable";
  if (u.includes("breezy.hr")) return "breezy";
  if (u.includes("ashbyhq")) return "ashby";
  if (u.includes("smartrecruiters")) return "smartrecruiters";
  if (u.includes("careers-page.com") || u.includes("manatal.com")) return "manatal";
  if (u.includes("icims.com")) return "icims";
  if (/^https?:\/\/careers\./.test(u) && /\/postings\/.+\/applications/.test(u)) return "pinpoint";
  if (u.includes("linkedin.")) return "linkedin";
  if (u.includes("dice.com")) return "dice";
  if (u.includes("wellfound") || u.includes("angel.co")) return "wellfound";
  if (u.includes("monster.")) return "monster";
  return null;
}

function sourceMeta(source) {
  const k = String(source || "").toLowerCase().trim();
  if (k && SOURCE_META[k]) return SOURCE_META[k];
  if (k) return { label: prettySource(k), color: "#5b647a", short: k.slice(0, 2).toUpperCase() };
  return DEFAULT_SOURCE_META;
}

function prettySource(s) {
  const k = String(s || "").toLowerCase().trim();
  if (!k) return null;
  return (SOURCE_META[k] && SOURCE_META[k].label) || k.charAt(0).toUpperCase() + k.slice(1);
}

// Compact relative time, e.g. "Today", "3d ago", "2w ago".
function timeAgo(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function scoreClass(score) {
  if (score == null) return "";
  if (score >= 90) return "high";
  if (score >= 80) return "mid";
  if (score >= 70) return "low";
  return "min";
}

function scoreLabel(score) {
  if (score >= 75) return "Strong";
  if (score >= 50) return "Good";
  if (score >= 25) return "Fair";
  return "Low";
}

function dashboardChips(j) {
  const chips = [];
  const added = relativeTime(j.created_at);
  if (added) chips.push({ label: `Added ${added}` });
  const posted = relativeTime(j.posted_date);
  if (posted) chips.push({ label: `Posted ${posted}` });
  if (j.work_mode) {
    const mode = String(j.work_mode).toLowerCase();
    const tone = mode === "remote" ? "ok" : mode === "hybrid" ? "warn" : "info";
    chips.push({ label: mode.charAt(0).toUpperCase() + mode.slice(1), tone });
  } else if (j.is_remote) {
    chips.push({ label: "Remote", tone: "ok" });
  }
  if (j.salary_raw) chips.push({ label: j.salary_raw });
  if (j.job_type) chips.push({ label: j.job_type });
  if (j.match_in_progress) chips.push({ label: "Matching…", tone: "warn", dot: true });
  // Only advertise docs when the tailor pipeline is actually ready (not failed leftover files).
  const cg = String(j.content_generation_status || "").toLowerCase();
  if (cg !== "failed" && cg !== "skipped") {
    if (j.resume_pdf_status === "completed") chips.push({ label: "Resume", tone: "ok", dot: true });
    if (j.cover_letter_pdf_status === "completed") chips.push({ label: "Cover letter", tone: "ok", dot: true });
  }
  if (j.pumble_posted_at) chips.push({ label: "Pumble", tone: "ok" });
  return chips;
}

function relativeTime(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function appliedChips(j) {
  const chips = [];
  const when = relativeTime(j.applied_at);
  chips.push({ label: when ? `Applied ${when}` : "Applied", tone: "ok", dot: true });
  if (j.work_mode) {
    const mode = String(j.work_mode).toLowerCase();
    chips.push({ label: mode.charAt(0).toUpperCase() + mode.slice(1), tone: mode === "remote" ? "ok" : "info" });
  } else if (j.is_remote) {
    chips.push({ label: "Remote", tone: "info" });
  }
  return chips;
}

function sessionChips(s, snap) {
  const chips = [];
  const posted = timeAgo(snap.posted_date) || timeAgo(s.created_at);
  if (posted) chips.push({ label: posted });
  if (snap.location) chips.push({ label: snap.location });
  chips.push({ label: "In progress", tone: "info", dot: true });
  return chips;
}

// A shimmering placeholder card shown while job data is still loading.
function skeletonCard() {
  return el("div", { class: "card skeleton" }, [
    el("div", { class: "skel-logo" }),
    el("div", { class: "card-main" }, [
      el("div", { class: "skel-line skel-title" }),
      el("div", { class: "skel-line skel-sub" }),
      el("div", { class: "skel-line skel-chips" }),
    ]),
    el("div", { class: "skel-pill" }),
  ]);
}

function renderSkeletonList(count = 5) {
  const list = el("div", { class: "list" });
  for (let i = 0; i < count; i++) list.appendChild(skeletonCard());
  return list;
}

// Renders one page of a (possibly massive) job list plus pagination controls.
function jobListSection(tabId, cards, emptyMsg) {
  if (!cards.length) {
    // Don't show "nothing here" until we actually know - show skeletons instead.
    if (state.queueLoading) return renderSkeletonList();
    return el("p", { class: "muted" }, emptyMsg);
  }

  const size = state.pageSize || JOBS_PAGE_SIZES[0];
  const totalPages = Math.max(1, Math.ceil(cards.length / size));
  const page = Math.min(Math.max(1, (state.pageByTab && state.pageByTab[tabId]) || 1), totalPages);
  const start = (page - 1) * size;
  const pageCards = cards.slice(start, start + size);

  const wrap = el("div", { class: "tab-panel job-list-section" });
  const pageJobIds = pageCards.map((c) => c.jobId).filter(Boolean);
  const bulkActions = renderListBulkActions(tabId, pageJobIds);
  if (bulkActions) wrap.appendChild(bulkActions);
  const list = el("div", { class: "list" });
  pageCards.forEach((c) => list.appendChild(jobCard(c)));
  wrap.appendChild(list);
  wrap.appendChild(renderPager(tabId, page, totalPages, cards.length, start, pageCards.length));
  return wrap;
}

function setTabPage(tabId, page) {
  setState({ pageByTab: { ...state.pageByTab, [tabId]: page } });
}

function renderListBulkActions(tabId, jobIds) {
  if (!state.pumbleConfigured || !jobIds.length) return null;
  if (tabId !== "today" && tabId !== "ready") return null;
  return el("div", { class: "list-bulk-actions" }, [
    el(
      "button",
      {
        class: "btn small pumble-post-btn",
        disabled: state.postingToPumble,
        title:
          (state.pumbleDestinationCount || 0) > 1
            ? "Post every job on this page to all configured Pumble destinations"
            : "Post every job on this page to your configured Pumble channel thread",
        onclick: () => postJobsToPumble(jobIds),
      },
      state.postingToPumble ? "Posting to Pumble…" : `Post ${jobIds.length} on this page to Pumble`
    ),
  ]);
}

function applyPageSize(size) {
  const n = size === 50 || size === 100 ? size : 25;
  void store.setPageSize(n);
  setState(
    { pageSize: n, pageByTab: { progress: 1, today: 1, ready: 1, tailor: 1 } },
    { resetScroll: true }
  );
}

// Builds a compact page sequence with ellipses, e.g. [1, "…", 6, 7, 8, "…", 42].
// Always keeps the first/last page and a window around the current page.
function pageSequence(current, total, span = 1) {
  const keep = new Set([1, total, current]);
  for (let i = 1; i <= span; i++) {
    if (current - i >= 1) keep.add(current - i);
    if (current + i <= total) keep.add(current + i);
  }
  const sorted = [...keep].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
}

function renderPager(tabId, page, totalPages, total, start, shown) {
  const sizer = el(
    "select",
    {
      class: "pager-size",
      title: "Results per page",
      "aria-label": "Results per page",
      onchange: (e) => applyPageSize(parseInt(e.target.value, 10) || JOBS_PAGE_SIZES[0]),
    },
    JOBS_PAGE_SIZES.map((n) =>
      el(
        "option",
        n === state.pageSize ? { value: String(n), selected: "selected" } : { value: String(n) },
        String(n)
      )
    )
  );

  const meta = el("div", { class: "pager-meta" }, [
    el("div", { class: "pager-range" }, [
      el("span", { class: "pager-range-nums" }, `${start + 1}–${start + shown}`),
      el("span", { class: "pager-range-of" }, ` of ${total}`),
    ]),
    el("label", { class: "pager-size-wrap" }, [
      el("span", { class: "pager-size-label" }, "Show"),
      sizer,
      el("span", { class: "pager-size-label" }, "per page"),
    ]),
  ]);

  if (totalPages <= 1) {
    return el("div", { class: "pager" }, [meta]);
  }

  const stepBtn = (label, target, { disabled = false, title } = {}) =>
    el(
      "button",
      {
        type: "button",
        class: "pager-step",
        disabled,
        title: title || label,
        "aria-label": title || label,
        onclick: () => setTabPage(tabId, target),
      },
      label
    );

  const pageBtn = (p) =>
    el(
      "button",
      {
        type: "button",
        class: "pager-page" + (p === page ? " is-active" : ""),
        title: `Page ${p}`,
        "aria-label": `Page ${p}`,
        "aria-current": p === page ? "page" : null,
        onclick: () => setTabPage(tabId, p),
      },
      String(p)
    );

  const pages = el(
    "div",
    { class: "pager-pages", role: "navigation", "aria-label": "Pagination" },
    pageSequence(page, totalPages).map((p) =>
      p === "…" ? el("span", { class: "pager-ellipsis", "aria-hidden": "true" }, "…") : pageBtn(p)
    )
  );

  const controls = el("div", { class: "pager-controls" }, [
    stepBtn("Prev", page - 1, { disabled: page <= 1, title: "Previous page" }),
    pages,
    stepBtn("Next", page + 1, { disabled: page >= totalPages, title: "Next page" }),
  ]);

  return el("div", { class: "pager" }, [
    meta,
    controls,
    el("div", { class: "pager-status muted small" }, `Page ${page} of ${totalPages}`),
  ]);
}

function renderHeader() {
  return el("div", { class: "header" }, [
    el("div", { class: "header-title" }, "Atomspace"),
    el("div", { class: "header-right" }, [
      el("span", { class: "muted small" }, state.user ? state.user.email : ""),
    ]),
  ]);
}

// Small inline SVG icons (stroke-based, inherit currentColor).
const ICON_BOLT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>';
const ICON_SEND =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>';
const ICON_STOP =
  '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_MAIL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>';
const ICON_LOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const ICON_EYE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="M2 2l20 20"/></svg>';
const ICON_NEXT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
const ICON_FLAG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22V4"/></svg>';
const ICON_ALERT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
const ICON_DOC =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/></svg>';
const ICON_DOWNLOAD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';
const ICON_LIST =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/></svg>';
const ICON_STAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3 6.5 7 .9-5 4.7 1.3 7L12 18l-6.3 3.1L7 14.1l-5-4.7 7-.9z"/></svg>';
const ICON_CHIP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>';
const ICON_BACK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
const ICON_CHART =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 16V9"/><path d="M12 16v-5"/><path d="M17 16V6"/></svg>';
const ICON_GEAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>';

function icon(svg, cls = "btn-ico") {
  return el("span", { class: cls, html: svg });
}

function renderSyncBanner() {
  return el("div", { class: "banner" }, [
    el("span", {}, `Your ${state.sync.changed.join(", ")} changed on the server.`),
    el("button", { class: "btn small primary", onclick: async () => {
      await syncNow();
      await loadQueue();
      setState({});
      toast("Synced.");
    } }, "Sync now"),
    el("button", { class: "btn small", onclick: () => setState({ sync: null }) }, "Dismiss"),
  ]);
}

function renderMinScoreControl({ compact = true } = {}) {
  const input = el("input", {
    type: "number",
    min: "0",
    max: "100",
    step: "1",
    class: "score-input",
    value: String(state.minScore),
  });
  const range = el("input", {
    type: "range",
    min: "0",
    max: "100",
    step: "1",
    class: "score-range",
    value: String(state.minScore),
  });
  const reloadBtn = el(
    "button",
    {
      type: "button",
      class: "btn small primary",
      disabled: true,
      onclick: () => {
        const v = parseInt(input.value, 10);
        applyMinScore(Number.isFinite(v) ? v : store.DEFAULT_MIN_SCORE);
      },
    },
    compact ? "Reload" : "Apply"
  );
  const syncControls = (raw) => {
    const v = parseInt(raw, 10);
    const ok = Number.isFinite(v);
    if (ok) {
      input.value = String(v);
      range.value = String(v);
    }
    reloadBtn.disabled = !(ok && v !== state.minScore);
  };
  input.addEventListener("input", () => syncControls(input.value));
  range.addEventListener("input", () => syncControls(range.value));
  return el("div", { class: "score-control" + (compact ? "" : " score-control-full") }, [
    el("label", { class: "min-score-label" }, "Min match score"),
    range,
    input,
    reloadBtn,
  ]);
}

const ICON_BRIEFCASE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/></svg>';

function jobCard({ title, company, location, score, onClick, badge, chips = [], source, docDownloads }) {
  const meta = sourceMeta(source);
  const side = [];
  if (score != null) {
    side.push(
      el("div", { class: "score-block " + scoreClass(score), title: `Match score: ${score}/100 - ${scoreLabel(score)}` }, [
        el("span", { class: "score-value" }, `${score}`),
        el("span", { class: "score-label" }, scoreLabel(score)),
      ])
    );
  }
  if (badge) side.push(el("span", { class: "badge tiny" }, badge));
  const docs = renderDocDownloadActions(docDownloads, { compact: true });
  if (docs) side.push(docs);

  const logo = meta.short
    ? el("div", { class: "card-logo", title: meta.label || "" }, meta.short)
    : el("div", { class: "card-logo neutral", title: "Other source", html: ICON_BRIEFCASE });

  const subtitle = [company, location].filter(Boolean).join(" · ");

  return el(
    "div",
    { class: "card", style: `--src-color:${meta.color}`, onclick: onClick },
    [
      logo,
      el("div", { class: "card-main" }, [
        el("div", { class: "card-title", title }, title),
        subtitle ? el("div", { class: "card-sub muted", title: subtitle }, subtitle) : null,
        chips.length ? el("div", { class: "card-chips" }, chips.map(renderChip)) : null,
      ]),
      side.length ? el("div", { class: "card-side" }, side) : null,
    ]
  );
}

function renderChip(c) {
  const kids = [];
  if (c.dot) kids.push(el("span", { class: "chip-dot" }));
  kids.push(el("span", {}, c.label));
  return el("span", { class: "chip" + (c.tone ? " " + c.tone : "") }, kids);
}

function renderJob() {
  const wrap = el("div", { class: "screen job" });
  wrap.appendChild(
    el("div", { class: "header job-header" }, [
      el("button", { class: "btn link", onclick: () => goHome() }, "Back"),
      el("div", { class: "header-right" }, [
        state.job && state.job.score != null ? el("span", { class: "score" }, `${state.job.score}`) : null,
      ]),
    ])
  );

  if (!state.job) {
    wrap.appendChild(renderSpinner("Loading job…"));
    if (state.error) wrap.appendChild(el("div", { class: "error" }, state.error));
    return wrap;
  }

  const job = state.job;
  wrap.appendChild(
    el("div", { class: "job-hero" }, [
      el("h1", { class: "job-title" }, job.title || "(untitled job)"),
      el("div", { class: "job-company muted" }, job.company || ""),
    ])
  );

  // Already-applied jobs are read-only here: skip the autofill UI and show an
  // applied confirmation instead.
  if (job.applied) {
    const when = timeAgo(job.appliedAt);
    wrap.appendChild(
      el("div", { class: "banner ok" }, when ? `Applied ${when}` : "Already applied")
    );
  } else {
    wrap.appendChild(renderAutofillPanel());
  }

  if (!job.ready) {
    wrap.appendChild(
      el("div", { class: "banner warn" }, [
        el("span", {}, "Structured job description not ready yet."),
        el("button", { class: "btn small primary", onclick: () => runAnalysis() }, "Run analysis"),
      ])
    );
  }
  wrap.appendChild(renderJdDetails(job));

  wrap.appendChild(renderChatSection(job));
  if (state.error) wrap.appendChild(el("div", { class: "error", onclick: () => setState({ error: null }) }, state.error));
  // Footer last so it stays flush against the panel bottom edge.
  wrap.appendChild(renderJobFooter());
  return wrap;
}

/** Shared resume/cover download controls (JD header + Tailor cards). */
function renderDocDownloadActions(docs, { compact = false } = {}) {
  if (!docs || !docs.jobId) return null;
  const resumeReady = !!(docs.resumePdf || docs.resumeDocx);
  const coverReady = !!(docs.coverPdf || docs.coverDocx);
  if (compact && !resumeReady && !coverReady) return null;

  const resumeTypes = [
    docs.resumePdf ? "resume_pdf" : null,
    docs.resumeDocx ? "resume_docx" : null,
  ].filter(Boolean);
  const coverTypes = [
    docs.coverPdf ? "cover_letter_pdf" : null,
    docs.coverDocx ? "cover_letter_docx" : null,
  ].filter(Boolean);

  const stopCard = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const mkBtn = ({ ready, fileTypes, short, title, readyTitle }) =>
    el(
      "button",
      {
        type: "button",
        class: (compact ? "card-doc-btn" : "jd-doc-btn") + (ready ? " is-ready" : " is-disabled"),
        title: ready ? readyTitle : title,
        disabled: ready ? undefined : true,
        onclick: (e) => {
          stopCard(e);
          if (!ready) return;
          void downloadJobDoc(docs.jobId, fileTypes, readyTitle);
        },
      },
      [
        icon(ICON_DOWNLOAD, compact ? "card-doc-btn-ico" : "jd-doc-btn-ico"),
        el("span", { class: compact ? "card-doc-btn-label" : "jd-doc-btn-label" }, short),
      ]
    );

  return el(
    "div",
    {
      class: compact ? "card-doc-actions" : "jd-doc-actions",
      onclick: stopCard,
      onmousedown: stopCard,
    },
    [
      mkBtn({
        ready: resumeReady,
        fileTypes: resumeTypes,
        short: compact ? "R" : "Resume",
        title: "Tailored resume not ready yet",
        readyTitle: "Download tailored resume",
      }),
      mkBtn({
        ready: coverReady,
        fileTypes: coverTypes,
        short: compact ? "CL" : "Cover",
        title: "Cover letter not ready yet",
        readyTitle: "Download cover letter",
      }),
    ]
  );
}

function renderJdDocDownloadActions(job) {
  const docs = (job && job.docs) || emptyJobDocs();
  return renderDocDownloadActions({
    jobId: job && job.job_id,
    resumePdf: !!docs.resumePdf,
    resumeDocx: !!docs.resumeDocx,
    coverPdf: !!docs.coverPdf,
    coverDocx: !!docs.coverDocx,
  });
}

function renderJdDetails(job) {
  const snap = (job && job.snapshot) || {};
  // Only auto-expand when ready AND jdOpen. Chat sets jdOpen=false; do not key
  // off job.ready alone or every setState (stream deltas, autofill) re-opens it.
  const expanded = !!(state.jdOpen && job && job.ready);
  const details = el("details", {
    class: "jd",
    open: expanded ? "open" : undefined,
    ontoggle: (e) => {
      const node = e && e.target;
      if (!node || node !== details) return;
      const open = !!node.open;
      if (open === !!state.jdOpen) return;
      setState({ jdOpen: open });
    },
  });
  details.appendChild(
    el("summary", { class: "jd-summary" }, [
      el("span", { class: "jd-summary-left" }, [
        icon(ICON_DOC, "jd-summary-ico"),
        el("span", {}, "Job description"),
      ]),
      renderJdDocDownloadActions(job),
    ])
  );
  const body = el("div", { class: "jd-body" });

  if (!job || !job.ready) {
    body.appendChild(
      el(
        "p",
        { class: "muted small" },
        "Structured details are still preparing. You can download tailored docs above when ready."
      )
    );
    details.appendChild(body);
    return details;
  }

  // Quick facts grid - only the fields that exist.
  const facts = [];
  const addFact = (label, value) => {
    if (value) facts.push({ label, value });
  };
  addFact("Location", snap.location);
  addFact("Type", snap.employment_type);
  addFact("Salary", snap.salary_range);
  addFact("Remote", snap.remote_policy);
  addFact("Level", snap.experience_level);
  addFact("Industry", snap.industry);
  addFact("Posted", timeAgo(snap.posted_date));
  if (facts.length) {
    body.appendChild(
      el(
        "div",
        { class: "jd-facts" },
        facts.map((f) =>
          el("div", { class: "jd-fact" }, [
            el("span", { class: "jd-fact-label" }, f.label),
            el("span", { class: "jd-fact-value" }, f.value),
          ])
        )
      )
    );
  }

  const listEl = (items) => {
    if (!items || !items.length) return null;
    const ul = el("ul", { class: "jd-list" });
    items.forEach((i) => ul.appendChild(el("li", {}, i)));
    return ul;
  };
  const section = (iconSvg, title, content) => {
    if (!content) return;
    body.appendChild(
      el("section", { class: "jd-section" }, [
        el("div", { class: "jd-head" }, [icon(iconSvg, "jd-head-ico"), el("span", {}, title)]),
        content,
      ])
    );
  };

  section(ICON_DOC, "Summary", snap.description ? el("p", { class: "jd-text" }, snap.description.slice(0, 1500)) : null);
  section(ICON_LIST, "Requirements", listEl(snap.requirements));
  section(ICON_BRIEFCASE, "Responsibilities", listEl(snap.responsibilities));
  section(ICON_STAR, "Benefits", listEl(snap.benefits));

  details.appendChild(body);
  return details;
}

function renderReportNotice() {
  const n = state.reportNotice;
  if (!n) return null;
  const who = [n.reportedTitle, n.reportedCompany].filter(Boolean).join(" · ");
  const card = el("div", { class: "report-notice", role: "status" }, [
    el("div", { class: "report-notice-icon" }, icon(ICON_CHECK, "report-notice-icon-svg")),
    el("div", { class: "report-notice-body" }, [
      el("div", { class: "report-notice-title" }, "Reported as expired"),
      el("div", { class: "report-notice-sub muted" }, who ? `${who} was removed from your queue.` : "That job was removed from your queue."),
      el("div", { class: "report-notice-actions" }, [
        el(
          "button",
          {
            class: "btn report-notice-report",
            onclick: () => reportInvalidJob(),
          },
          [icon(ICON_FLAG), el("span", {}, "Report this job too")],
        ),
        el("button", { class: "btn link small", onclick: () => dismissReportNotice() }, "Dismiss"),
      ]),
    ]),
    el(
      "button",
      {
        class: "report-notice-close",
        title: "Dismiss",
        "aria-label": "Dismiss",
        onclick: () => dismissReportNotice(),
      },
      "×",
    ),
  ]);
  return card;
}

function renderChatSection(job) {
  const section = el("div", { class: "chat-section" });
  const notice = renderReportNotice();
  if (notice) section.appendChild(notice);
  section.appendChild(renderChat(job));
  return section;
}

function renderChat(job) {
  const chat = el("div", { class: "chat" });
  const msgs = el("div", { class: "messages", "data-scroll-preserve": "messages" });
  if (!job.messages.length) {
    const hotkeyLabel = store.formatAskHotkey(state.askHotkey);
    msgs.appendChild(
      el("div", { class: "chat-empty muted" }, [
        icon(ICON_BOLT, "chat-empty-icon"),
        el("span", {}, "Ask anything about this application."),
        el(
          "span",
          { class: "chat-empty-hotkey" },
          `Tip: select a question on the page, then press ${hotkeyLabel}.`
        ),
      ])
    );
  }
  job.messages.forEach((m) => {
    const isAssistant = m.role === "assistant";
    const bubble = el("div", { class: `msg ${m.role}` + (isAssistant ? " md" : "") });
    const inner = isAssistant ? renderMarkdown(m.content) : escapeHtml(m.content).replace(/\n/g, "<br>");
    bubble.innerHTML = inner + (m._streaming ? '<span class="cursor">|</span>' : "");
    if (isAssistant) {
      const row = el("div", { class: "msg-row assistant" }, [bubble]);
      if (!m._streaming) {
        // Copy the plain-text version so formatting marks (**, -, #, …) are dropped.
        const copyBtn = el(
          "button",
          {
            type: "button",
            class: "copy-btn",
            title: "Copy answer",
            onclick: (e) => {
              e.stopPropagation();
              void copyAnswer(mdToPlain(m.content), copyBtn);
            },
          },
          [
            el("span", { class: "copy-btn-ico", html: ICON_COPY }),
            el("span", { class: "copy-btn-label" }, "Copy"),
          ]
        );
        row.appendChild(copyBtn);
      }
      msgs.appendChild(row);
    } else {
      msgs.appendChild(bubble);
    }
  });
  chat.appendChild(msgs);
  setTimeout(() => (msgs.scrollTop = msgs.scrollHeight), 0);

  const ta = el("textarea", {
    class: "composer-input",
    placeholder: `Ask the assistant…  (Enter to send · or select text on the page + ${store.formatAskHotkey(state.askHotkey)})`,
    rows: 3,
  });
  const send = () => {
    const v = ta.value;
    ta.value = "";
    askQuestion(v);
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  const sendBtn = state.streaming
    ? el(
        "button",
        { class: "icon-btn stop composer-ask-btn", title: "Stop generating", onclick: () => stopStreaming() },
        [icon(ICON_STOP), el("span", {}, "Stop")]
      )
    : el(
        "button",
        { class: "icon-btn primary composer-ask-btn", title: "Send (Enter)", onclick: send },
        [icon(ICON_SEND), el("span", {}, "Ask")]
      );

  // Full-width input; Tone / Answer type / Ask sit on one flush toolbar row below
  // (no vertical gap or divider between input and that group).
  chat.appendChild(
    el("div", { class: "composer-block" }, [
      el("div", { class: "composer" }, [ta]),
      el("div", { class: "composer-toolbar" }, [
        labeledSelect("Tone", STYLES, state.style, (v) => setState({ style: v })),
        labeledSelect("Answer type", FIELD_TYPES, state.fieldType, (v) => setState({ fieldType: v })),
        sendBtn,
      ]),
    ])
  );
  return chat;
}

function labeledSelect(label, options, value, onChange) {
  return el("label", { class: "control" }, [
    el("span", { class: "control-label" }, label),
    el("span", { class: "select-wrap" }, selectEl(options, value, onChange)),
  ]);
}

function selectEl(options, value, onChange) {
  const sel = el("select", { class: "select", onchange: (e) => onChange(e.target.value) });
  options.forEach(([val, label]) => {
    const opt = el("option", { value: val }, label);
    if (val === value) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

function afBadgeLabel(level) {
  switch (level) {
    case "valid":
      return "1 field";
    case "group":
      return "multi";
    case "custom":
      return "custom";
    case "file":
      return "file";
    case "shadow":
      return "shadow";
    default:
      return "no input";
  }
}

function afStatusLabel(status) {
  switch (status) {
    case "filled":
      return "filled";
    case "attached":
      return "attached";
    case "partial":
      return "partial";
    case "needs_user":
      return "needs you";
    case "skipped":
      return "skipped";
    case "not_found":
      return "not found";
    default:
      return status || "";
  }
}

// Aggregate per-control statuses (keyed by cid) into one badge per block.
function blockStatus(handle) {
  const af = state.autofill;
  const spec = (af.specs || []).find((s) => s.handle === handle);
  if (!spec) return null;
  const got = (spec.controls || []).map((c) => af.statuses[c.cid]).filter(Boolean);
  if (!got.length) return null;
  if (got.some((s) => s === "filled" || s === "attached")) {
    return got.some((s) => s === "needs_user" || s === "skipped" || s === "not_found") ? "partial" : "filled";
  }
  if (got.every((s) => s === "needs_user")) return "needs_user";
  if (got.some((s) => s === "not_found")) return "not_found";
  return "skipped";
}

function renderSquareAutofillBtn({ label, title, onClick, disabled, busy, tone }) {
  return el(
    "button",
    {
      type: "button",
      class:
        "af-square-btn" +
        (tone === "primary" || !tone ? " primary" : "") +
        (busy ? " is-busy" : "") +
        (disabled ? " is-disabled" : ""),
      title: title || label,
      disabled: disabled || busy ? true : undefined,
      onclick: () => {
        if (!disabled && !busy && onClick) onClick();
      },
    },
    [
      busy
        ? el("span", { class: "af-square-spinner", "aria-hidden": "true" })
        : icon(ICON_BOLT, "af-square-ico"),
      el("span", { class: "af-square-label" }, label),
    ]
  );
}

function renderAutofillSideStatus(nodes) {
  return el("div", { class: "af-side" }, nodes.filter(Boolean));
}

function renderAutofillPanel() {
  const af = state.autofill;
  const wrap = el("div", { class: "autofill" });

  if (!af.active) {
    const previewEngine = state.job && state.job.engine;
    const ok = !previewEngine || previewEngine.available;
    wrap.appendChild(
      el("div", { class: "af-row" }, [
        renderSquareAutofillBtn({
          label: "Fill",
          title: ok ? "Autofill this page" : `${previewEngine.label} engine coming soon`,
          tone: "primary",
          disabled: !ok,
          onClick: () => startAutofill(),
        }),
        renderAutofillSideStatus([
          el("div", { class: "af-side-title" }, "Autofill"),
          previewEngine
            ? ok
              ? el("div", { class: "af-side-line" }, [
                  el("span", { class: "af-pill info" }, previewEngine.label),
                  el("span", { class: "af-side-text" }, "Ready — click Fill to run"),
                ])
              : el("div", { class: "af-side-line warn" }, [
                  icon(ICON_ALERT, "af-inline-ico"),
                  el(
                    "span",
                    { class: "af-side-text" },
                    `${previewEngine.label} dedicated engine coming soon`
                  ),
                ])
            : el("div", { class: "af-side-text muted" }, "Open the application tab, then fill."),
        ]),
      ])
    );
    return wrap;
  }

  // Deterministic engines (Workday) have a distinct panel: no picking / field
  // list - just run status and a per-step filled/missed report.
  if (af.engine && af.engine.mode === "workday") {
    return renderWorkdayPanel(af);
  }

  const engineName = (af.engine && af.engine.label) || "Assistant";
  const autoDiscover = !!(af.engine && af.engine.autoDiscover);
  const fieldCount = (af.fields || []).length;
  const primaryField = af.fields && af.fields[0];
  const primaryStatus = primaryField ? blockStatus(primaryField.handle) : null;
  const needsN = (af.needsUser && af.needsUser.length) || 0;

  let btnLabel = "Fill";
  let btnTitle = "Run autofill";
  let btnBusy = !!af.running;
  let btnDisabled = false;
  let onClick = () => runAutofill();
  if (af.discovering) {
    btnLabel = "Scan";
    btnTitle = "Scanning the application form…";
    btnBusy = true;
    btnDisabled = true;
    onClick = null;
  } else if (af.picking) {
    btnLabel = "Pick";
    btnTitle = "Selecting fields on the page";
    btnDisabled = true;
    onClick = null;
  } else if (!fieldCount) {
    btnDisabled = true;
    btnTitle = "No fields selected yet";
  } else {
    btnLabel = String(fieldCount);
    btnTitle = `Autofill ${fieldCount} field${fieldCount === 1 ? "" : "s"}`;
  }

  const sideKids = [];
  sideKids.push(
    el("div", { class: "af-side-top" }, [
      el("div", { class: "af-side-title" }, [
        el("span", {}, "Autofill"),
        el("span", { class: "af-side-engine" }, engineName),
      ]),
      el("button", { class: "btn link af-side-cancel", onclick: () => cancelAutofill() }, "Cancel"),
    ])
  );

  if (af.discovering) {
    sideKids.push(
      el("div", { class: "af-side-line" }, [
        el("span", { class: "af-pill warn pulse" }, "Scanning"),
        el("span", { class: "af-side-text" }, "Looking for the application form…"),
      ])
    );
  } else if (af.picking) {
    sideKids.push(
      el("div", { class: "af-side-line" }, [
        el("span", { class: "af-pill warn" }, "Selecting"),
        el("span", { class: "af-side-text" }, "Click field blocks on the page · Esc to stop"),
      ])
    );
  } else if (af.running) {
    sideKids.push(
      el("div", { class: "af-side-line" }, [
        el("span", { class: "af-pill info pulse" }, "Running"),
        el("span", { class: "af-side-text" }, af.runStatus || "Filling the application…"),
      ])
    );
  } else if (primaryField) {
    sideKids.push(
      el("div", { class: "af-side-line af-side-field" }, [
        el("span", { class: `af-badge ${primaryField.level}` }, afBadgeLabel(primaryField.level)),
        el("span", { class: "af-label" }, primaryField.label || "(field)"),
        primaryStatus
          ? el("span", { class: `af-status ${primaryStatus}` }, afStatusLabel(primaryStatus))
          : null,
        !autoDiscover
          ? el(
              "button",
              {
                class: "af-remove",
                title: "Remove",
                onclick: () => removeAutofillField(primaryField.handle),
              },
              "×"
            )
          : null,
      ])
    );
  } else {
    sideKids.push(el("div", { class: "af-side-text muted" }, "No fields selected yet."));
  }

  if (af.error) {
    sideKids.push(
      el(
        "div",
        {
          class: "af-alert danger",
          title: af.error,
          onclick: () => setAutofill({ error: null }),
        },
        [icon(ICON_ALERT, "af-inline-ico"), el("span", {}, af.error)]
      )
    );
  }

  if (needsN > 0 && !af.running && !af.discovering) {
    const first = af.needsUser[0];
    const extra = needsN > 1 ? ` +${needsN - 1} more` : "";
    sideKids.push(
      el("div", { class: "af-alert warn", title: first.reason || "Needs your input" }, [
        icon(ICON_ALERT, "af-inline-ico"),
        el(
          "span",
          { class: "af-alert-text" },
          `${first.label || "Field"}${extra}: ${first.reason || "Needs your input"}`
        ),
      ])
    );
  }

  if (!autoDiscover && !af.discovering && !af.picking && !af.running) {
    sideKids.push(
      el(
        "button",
        { type: "button", class: "btn link small af-more-fields", onclick: () => resumePicking() },
        "Select more fields"
      )
    );
  }

  // Extra selected fields (beyond the first) stay compact under the side column.
  if (af.fields.length > 1 && !af.discovering) {
    const rest = el("div", { class: "af-list af-list-compact" });
    af.fields.slice(1).forEach((f) => {
      const status = blockStatus(f.handle);
      rest.appendChild(
        el("div", { class: "af-item" }, [
          el("span", { class: `af-badge ${f.level}` }, afBadgeLabel(f.level)),
          el("span", { class: "af-label" }, f.label || "(field)"),
          status ? el("span", { class: `af-status ${status}` }, afStatusLabel(status)) : null,
          el(
            "button",
            { class: "af-remove", title: "Remove", onclick: () => removeAutofillField(f.handle) },
            "×"
          ),
        ])
      );
    });
    sideKids.push(rest);
  }

  wrap.appendChild(
    el("div", { class: "af-row" }, [
      renderSquareAutofillBtn({
        label: btnLabel,
        title: btnTitle,
        tone: "primary",
        busy: btnBusy,
        disabled: btnDisabled,
        onClick,
      }),
      renderAutofillSideStatus(sideKids),
    ])
  );
  return wrap;
}

const WD_STEP_LABELS = {
  myInfo: "My Information",
  experience: "My Experience",
  voluntary: "Voluntary Disclosures",
  selfid: "Self Identify",
  questions: "Application Questions",
  generic: "Current step",
  review: "Review",
  unknown: "Current step",
};

function renderWorkdayPanel(af) {
  const wrap = el("div", { class: "autofill" });
  const busy = !!af.running;
  const sideKids = [
    el("div", { class: "af-side-top" }, [
      el("div", { class: "af-side-title" }, [
        el("span", {}, af.autoLoop ? "Auto-advance" : "Autofill"),
        el("span", { class: "af-side-engine" }, "Workday"),
      ]),
      el(
        "button",
        {
          class: "btn link af-side-cancel",
          onclick: () => (af.running ? stopWorkdayAutofill() : cancelAutofill()),
        },
        af.running ? "Stop" : "Close"
      ),
    ]),
  ];

  if (af.running && af.autoLoop) {
    sideKids.push(
      el("div", { class: "af-side-line" }, [
        el("span", { class: "af-pill info pulse" }, "Running"),
        el("span", { class: "af-side-text" }, af.loopStatus || "Working through the application…"),
      ])
    );
  } else if (af.running) {
    sideKids.push(
      el("div", { class: "af-side-line" }, [
        el("span", { class: "af-pill info pulse" }, "Filling"),
        el("span", { class: "af-side-text" }, "Filling the current step from your profile…"),
      ])
    );
  } else if (af.autoLoop && af.done && af.loopMessage) {
    const tone =
      af.loopFinished === "review"
        ? "ok"
        : af.loopFinished === "error" ||
            af.loopFinished === "needs_user" ||
            af.loopFinished === "stuck"
          ? "warn"
          : "info";
    sideKids.push(
      el("div", { class: `af-alert ${tone}` }, [
        icon(tone === "ok" ? ICON_CHECK : ICON_ALERT, "af-inline-ico"),
        el("span", { class: "af-alert-text" }, af.loopMessage),
      ])
    );
  } else if (af.done && !af.reports.length && !af.error) {
    sideKids.push(
      el("div", { class: "af-side-text muted" }, "No Workday step detected. Open the application and try again.")
    );
  } else if (!af.done) {
    sideKids.push(el("div", { class: "af-side-text muted" }, "Starting…"));
  }

  if (af.error) {
    sideKids.push(
      el("div", { class: "af-alert danger" }, [
        icon(ICON_ALERT, "af-inline-ico"),
        el("span", { class: "af-alert-text" }, af.error),
      ])
    );
  }

  if (af.reports && af.reports.length) {
    const list = el("div", { class: "af-list af-list-compact" });
    af.reports.forEach((r) => {
      const toCheck = [...(r.missed || []), ...((r.unmatched || []).map((u) => u.label || u.key))];
      list.appendChild(
        el("div", { class: "af-item af-step" }, [
          el("span", { class: "af-label" }, WD_STEP_LABELS[r.step] || r.step),
          el("span", { class: "af-status filled" }, `${(r.filled || []).length} filled`),
          toCheck.length
            ? el("span", { class: "af-status not_found", title: toCheck.join(", ") }, `${toCheck.length} to check`)
            : null,
        ])
      );
    });
    sideKids.push(list);
    if (!af.autoLoop) {
      sideKids.push(
        el(
          "p",
          { class: "muted small af-wd-hint" },
          "Review, click Workday Continue, then re-run — Submit is yours."
        )
      );
    }
  }

  const loopMode = state.autoAdvance;
  wrap.appendChild(
    el("div", { class: "af-row" }, [
      renderSquareAutofillBtn({
        label: busy ? "…" : af.done ? "Again" : "WD",
        title: af.done
          ? loopMode
            ? "Run again from this step"
            : "Fill this step again"
          : af.autoLoop
            ? "Workday auto-advance"
            : "Workday autofill",
        tone: "primary",
        busy,
        disabled: busy ? true : !af.done,
        onClick: af.done && !busy ? () => rerunWorkday() : null,
      }),
      renderAutofillSideStatus(sideKids),
    ])
  );
  return wrap;
}

async function rerunWorkday() {
  const af = state.autofill;
  if (!af || !af.tabId || !af.engine) return;
  const job = state.job;
  if (!job || !job.job_id) return;
  const tabId = af.tabId;
  const useLoop = state.autoAdvance;
  setAutofill({
    running: true,
    done: false,
    reports: [],
    error: null,
    autoLoop: useLoop,
    loopStop: false,
    loopFinished: null,
    loopMessage: null,
  });
  const resumeSource = (buildPreferences() || {}).resume_source === "original" ? "original" : "tailored";
  try {
    const profile = await api.getAutofillProfile(job.job_id, resumeSource);
    let resumeFile = null;
    try {
      resumeFile = await api.downloadResumeFile(job.job_id, "resume_pdf");
      console.debug("[workday] resume PDF downloaded:", (resumeFile && resumeFile.filename) || "(unnamed)", "b64=", resumeFile && resumeFile.base64 && resumeFile.base64.length);
    } catch (e) {
      console.warn("[workday] resume PDF download failed:", (e && e.message) || e);
      resumeFile = null;
      toast((e && e.message) || "Could not download the tailored resume PDF for upload.");
    }
    if (useLoop) {
      await autoAdvanceWorkday(tabId, profile, resumeFile);
      return;
    }
    const runSeq = ++wdRunSeq;
    await chrome.tabs.sendMessage(tabId, {
      type: "WD_RUN",
      profile,
      options: { autoAdvance: false, resumeFile, newAttempt: true },
      runSeq,
    });
    armWorkdayWatchdog();
  } catch (err) {
    setAutofill({ running: false, done: true, error: (err && err.message) || String(err) });
  }
}

const ICON_MSG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

function renderJobFooter() {
  const pumbleBtn =
    state.pumbleConfigured && state.job
      ? el(
          "button",
          {
            class: "btn footer-btn pumble-post-btn",
            disabled: state.postingToPumble || state.job.pumblePosted,
            title: state.job.pumblePosted
              ? "Already posted to Pumble"
              : "Post this job URL to your Pumble channel thread",
            onclick: () => postJobsToPumble([state.job.job_id]),
          },
          [
            icon(ICON_MSG),
            el("span", {}, state.job.pumblePosted ? "Posted to Pumble" : "Post to Pumble"),
          ]
        )
      : null;

  return el("div", { class: "footer" }, [
    el("button", { class: "btn footer-btn", onclick: () => completeJob({ next: false }) }, [
      icon(ICON_CHECK),
      el("span", {}, "Complete & Exit"),
    ]),
    el(
      "button",
      {
        class: "btn footer-report",
        title: "Report this job as expired / invalid and remove it",
        onclick: () => reportInvalidJob(),
      },
      [icon(ICON_FLAG), el("span", {}, "Report")]
    ),
    pumbleBtn,
    el("button", { class: "btn primary footer-btn", onclick: () => completeJob({ next: true }) }, [
      el("span", {}, "Complete & Next"),
      icon(ICON_NEXT),
    ]),
  ]);
}

init();
