import * as api from "./api.js";
import * as store from "./store.js";
import { resolveEngine } from "./engines.js";

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
  queue: [], // ready-to-apply jobs (resume built, scored, not yet applied)
  todayQueue: [], // jobs scraped today (any build state), not yet applied
  appliedQueue: [], // jobs applied to today (most recent first)
  homeTab: "progress", // active Home tab: "progress" | "today" | "ready" | "applied"
  pageByTab: { progress: 1, today: 1, ready: 1, applied: 1 }, // 1-based page per Home tab
  pageSize: 25, // rows per page, user-selectable
  queueLoading: false, // true while the Home job lists are being fetched
  modal: null, // { title, message, confirmLabel, tone, onConfirm, busy }
  minScore: store.DEFAULT_MIN_SCORE,
  autoAdvance: false, // Workday: fill + advance each step until Review (user submits)
  job: null, // { job_id, url, title, company, score, snapshot, messages, ready }
  style: "standard",
  fieldType: "",
  streaming: false,
  abort: null,
  toast: null,
  error: null,
  autofill: emptyAutofill(),
};

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
  };
}

// Jobs can be massive, so every Home list is paginated client-side.
const JOBS_PAGE_SIZES = [25, 50, 100];

function setState(patch) {
  state = { ...state, ...patch };
  render();
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

// Messages from the injected picker/writer content script arrive here.
function onContentMessage(msg) {
  if (!msg || !msg.type) return;
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
    if (state.autofill.fields.some((f) => f.handle === msg.handle)) return;
    const field = {
      handle: msg.handle,
      label: msg.label || "(field)",
      level: msg.level || "valid",
      controlCount: msg.controlCount || 1,
    };
    setAutofill({ fields: [...state.autofill.fields, field] });
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
      wdStepWaiter({ reports: msg.reports || [] });
      return;
    }
    setAutofill({ running: false, done: true, reports: msg.reports || state.autofill.reports });
  } else if (msg.type === "WD_ERROR") {
    if (!state.autofill.active) return;
    if (wdStepWaiter) {
      wdStepWaiter({ error: msg.error || "Autofill failed" });
      return;
    }
    setAutofill({ running: false, done: true, error: msg.error || "Autofill failed", reports: msg.reports || state.autofill.reports });
  } else if (msg.type === "WD_RESOLVE") {
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
    if (!job || !job.job_id || !items.length) return reply({});
    // Generic: each item carries its own control kind/options (Degree, Field of
    // Study, and any unmatched Workday question routed here from the engine).
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
        if (c.needs_user) continue; // leave for manual review, don't guess
        const v = c.option || c.value;
        if (c.cid && v) values[c.cid] = v;
      }
    }
    reply(values);
  } catch {
    reply({});
  }
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(onContentMessage);
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

// Strip markdown to plain text for copying — what you copy matches what you read.
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

function toast(msg) {
  setState({ toast: msg });
  setTimeout(() => {
    if (state.toast === msg) setState({ toast: null });
  }, 3500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text || "");
    toast("Copied");
  } catch {
    toast("Copy failed");
  }
}

// ── init ────────────────────────────────────────────────────────────────────

async function init() {
  const [user, token, minScore, autoAdvance] = await Promise.all([
    store.getCurrentUser(),
    store.getToken(),
    store.getMinScore(),
    store.getAutoAdvance(),
  ]);
  state.minScore = minScore;
  state.autoAdvance = autoAdvance;
  if (user && token) {
    state.user = user;
    state.cache = await store.getCache(user.user_id);
    await goHome();
  } else {
    setState({ view: "login" });
  }
}

// ── auth actions ─────────────────────────────────────────────────────────────

async function doLogin(backendUrl, email, password) {
  setState({ error: null });
  const granted = await api.ensureHostPermission(backendUrl);
  if (!granted) {
    setState({ error: "Permission to access the backend URL was denied." });
    return;
  }
  try {
    const user = await api.login(backendUrl, email, password);
    state.user = user;
    state.minScore = await store.getMinScore();
    await syncNow(); // first load populates the cache
    await goHome();
  } catch (err) {
    setState({ error: err.message || "Login failed." });
  }
}

async function doLogout() {
  await api.logout();
  await store.clearCurrentUser();
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
  setState({ view: "home", job: null });
  await Promise.all([loadQueue(), checkSync()]);
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// The dashboard caps per_page at 200, so a single request only returns the 200
// newest jobs — older "ready to apply" jobs would be cut off. Page through the
// whole list (newest first) so the Ready tab reflects ALL jobs so far. Capped to
// keep the side panel responsive even on very large accounts.
async function fetchAllDashboardJobs(maxPages = 25) {
  const first = await api
    .getDashboard({ per_page: 200, page: 1, sort: "created_at", order: "desc" })
    .catch(() => ({ items: [], pages: 1 }));
  let items = first.items || [];
  const pages = Math.min(first.pages || 1, maxPages);
  if (pages > 1) {
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, i) =>
        api
          .getDashboard({ per_page: 200, page: i + 2, sort: "created_at", order: "desc" })
          .catch(() => ({ items: [] }))
      )
    );
    for (const r of rest) items = items.concat(r.items || []);
  }
  return items;
}

async function loadQueue() {
  // Show skeletons while we page through the (potentially large) dashboard.
  setState({ queueLoading: true });
  try {
    const [sessions, items] = await Promise.all([
      api.listSessions("in_progress").catch(() => []),
      fetchAllDashboardJobs(),
    ]);
    const minScore = state.minScore;
    const today = startOfToday();
    // A job is "ready" only once its WHOLE pipeline has finished and it hasn't
    // been applied to yet: match analysis scored it, content was generated
    // (resume tailoring), and both the resume DOCX and the uploadable PDF built.
    const pipelineComplete = (j) =>
      !j.applied_at &&
      j.match_overall_score != null &&
      j.content_generation_status === "completed" &&
      j.resume_build_status === "completed" &&
      j.resume_pdf_status === "completed";
    // New today: jobs scraped today whose resume tailoring (full pipeline) is done.
    const todayJobs = items.filter((j) => pipelineComplete(j) && j.created_at && new Date(j.created_at) >= today);
    // Ready to apply: all completed jobs (any date), further filtered by min score.
    const ready = items.filter((j) => pipelineComplete(j) && j.match_overall_score >= minScore);
    // Applied today: jobs we've submitted an application to since midnight, newest first.
    const appliedToday = items.filter((j) => j.applied_at && new Date(j.applied_at) >= today);
    const byScore = (a, b) => (b.match_overall_score ?? 0) - (a.match_overall_score ?? 0);
    const byAppliedDesc = (a, b) => new Date(b.applied_at || 0) - new Date(a.applied_at || 0);
    ready.sort(byScore);
    todayJobs.sort(byScore);
    appliedToday.sort(byAppliedDesc);
    setState({
      sessions: sessions || [],
      queue: ready,
      todayQueue: todayJobs,
      appliedQueue: appliedToday,
      pageByTab: { progress: 1, today: 1, ready: 1, applied: 1 },
      queueLoading: false,
    });
  } catch (err) {
    setState({ error: err.message, queueLoading: false });
  }
}

async function applyMinScore(value) {
  const n = await store.setMinScore(value);
  setState({ minScore: n });
  await loadQueue();
}

async function applyAutoAdvance(value) {
  const v = await store.setAutoAdvance(value);
  setState({ autoAdvance: v });
}

// ── job / chat actions ───────────────────────────────────────────────────────

async function openJob(jobId, { redirect = false } = {}) {
  setState({ view: "job", job: null, error: null });
  try {
    await api.createSession(jobId);
    const detail = await api.getSessionDetail(jobId);
    const snap = detail.job_snapshot || {};
    if (redirect && (snap.url || detail.job_url)) {
      await redirectActiveTab(snap.url || detail.job_url);
    }
    setState({
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
        messages: detail.messages || [],
        // Engine preview from the snapshot URL; re-resolved against the live tab
        // URL when autofill actually starts.
        engine: resolveEngine({ snapshot: snap }),
      },
    });
  } catch (err) {
    setState({ error: err.message });
  }
}

async function redirectActiveTab(url) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) await chrome.tabs.update(tab.id, { url });
  } catch (err) {
    console.warn("redirectActiveTab failed", err);
  }
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
  setState({ streaming: true, abort, job: { ...job } });

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

async function completeJob({ next }) {
  if (!state.job) return;
  const jobId = state.job.job_id;
  await teardownAutofill();
  try {
    await api.markApplied([jobId]);
    await api.updateSession(jobId, "completed").catch(() => {});
  } catch (err) {
    setState({ error: err.message });
    return;
  }
  if (next) {
    try {
      const nx = await api.nextJob(jobId);
      if (nx && nx.job_id) {
        await openJob(nx.job_id, { redirect: true });
        toast(`Loaded next job (${nx.remaining} ready remaining).`);
        return;
      }
      toast("No more ready-to-apply jobs.");
      await goHome();
    } catch (err) {
      setState({ error: err.message });
    }
  } else {
    // Complete & Exit closes the side panel.
    window.close();
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
  setState({ modal: { ...state.modal, busy: true } });
  try {
    await api.reportJobInvalid(jobId, "expired");
    await api.updateSession(jobId, "completed").catch(() => {});
  } catch (err) {
    setState({ modal: null, error: err.message });
    return;
  }
  await teardownAutofill();
  setState({ modal: null });
  toast("Reported as expired and removed.");
  try {
    const nx = await api.nextJob(jobId);
    if (nx && nx.job_id) {
      await openJob(nx.job_id, { redirect: true });
      return;
    }
  } catch {
    /* fall through to Home */
  }
  await goHome();
}

// ── autofill actions ─────────────────────────────────────────────────────────

async function startAutofill() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null || !/^https?:/i.test(tab.url || "")) {
      toast("Open the job application page in the active tab first.");
      return;
    }
    let origin;
    try {
      origin = new URL(tab.url).origin + "/*";
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
    // Host permission for the page must be requested on this user gesture.
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      toast("Permission to read this page was denied.");
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: "AUTOFILL_INJECT", tabId: tab.id, engine: engine.scripts });
    if (!res || !res.ok) {
      toast("Could not start autofill on this page.");
      return;
    }
    // Deterministic engines (Workday) fill straight from the canonical profile —
    // no manual region selection, no LLM.
    if (engine.mode === "workday") {
      await startWorkdayAutofill(tab, engine);
      return;
    }
    // Auto-discovery engines (Greenhouse): select the page's single application
    // container and fill it automatically — no manual field tagging.
    if (engine.autoDiscover) {
      setState({ autofill: { ...emptyAutofill(), active: true, discovering: true, tabId: tab.id, engine } });
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "AF_AUTOSELECT" });
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
    await chrome.tabs.sendMessage(tab.id, { type: "AF_START" });
    setState({ autofill: { ...emptyAutofill(), active: true, picking: true, tabId: tab.id, engine } });
  } catch (err) {
    toast("Autofill could not start: " + ((err && err.message) || err));
  }
}

// Workday: fetch the canonical structured profile (respecting the user's
// original/tailored resume preference), optionally attach the generated resume
// file, and tell the in-page engine to fill the current step. Auto-advance is
// OFF — the user reviews and clicks Continue between steps.
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
    console.warn("[workday] resume PDF downloaded:", (resumeFile && resumeFile.filename) || "(unnamed)");
  } catch (e) {
    console.warn("[workday] resume PDF download failed:", (e && e.message) || e);
    resumeFile = null;
  }

  // Auto-advance: drive the whole flow (fill → flush → recover → Save) until the
  // Review page. Otherwise fill just the current step and hand back to the user.
  if (state.autoAdvance) {
    setAutofill({ autoLoop: true, loopStop: false, loopFinished: null });
    await autoAdvanceWorkday(tab.id, profile, resumeFile);
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "WD_RUN",
      profile,
      options: { autoAdvance: false, resumeFile },
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
// Per step: how many Save attempts (each preceded by an LLM recovery pass when
// Workday reports errors before or after the Save click).
const WD_MAX_RECOVERIES = 3;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tabSend(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        void chrome.runtime.lastError; // swallow "no receiver" noise
        resolve(resp || null);
      });
    } catch {
      resolve(null);
    }
  });
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
  await delay(450); // let the focus event + flush settle
  await tabSend(tabId, { type: "WD_FLUSH" });
  await delay(150);
}

async function fillCurrentStep(tabId, profile, resumeFile) {
  const wait = waitWorkdayFill();
  await tabSend(tabId, { type: "WD_RUN", profile, options: { autoAdvance: false, resumeFile } });
  return wait;
}

async function autoAdvanceWorkday(tabId, profile, resumeFile) {
  const loopStopped = () => state.autofill.loopStop || !state.autofill.active;
  try {
    for (let i = 0; i < WD_MAX_STEPS; i++) {
      if (loopStopped()) return finishLoop("stopped");

      const det = await tabSend(tabId, { type: "WD_DETECT" });
      const step = det && det.step;
      if (!step) return finishLoop(state.autofill.reports.length ? "done" : "none");
      if (step === "review") return finishLoop("review");

      const label = WD_STEP_LABELS[step] || step;

      // Initial fill of the step.
      setAutofill({ loopStatus: `Filling ${label}…` });
      const fill = await fillCurrentStep(tabId, profile, resumeFile);
      if (fill.error) return finishLoop("error", fill.error);

      // Clear validation and advance. CRITICAL: Workday surfaces most required-
      // field errors only AFTER clicking "Save and Continue", so a clean pre-save
      // check is not enough. Each attempt: flush → fix visible errors via LLM →
      // Save → if it didn't move, re-validate (errors now show), LLM-recover, and
      // retry. Only give up after exhausting attempts (naming the stuck fields).
      let advanced = false;
      let lastNames = [];
      for (let attempt = 0; attempt < WD_MAX_RECOVERIES && !advanced; attempt++) {
        if (loopStopped()) return finishLoop("stopped");
        setAutofill({ loopStatus: `Committing ${label}…` });
        await focusPageAndFlush(tabId);

        // Fix anything already flagged before saving.
        let v = await tabSend(tabId, { type: "WD_VALIDATE" });
        if (v && !v.clean) {
          lastNames = (v.invalidFields || []).map((f) => f.label || f.key).filter(Boolean);
          console.warn(`[workday] auto-advance: ${label} pre-save errors`, v.invalidFields);
          setAutofill({ loopStatus: `Resolving ${v.errorCount || ""} issue(s) on ${label}…` });
          const rec = await fillCurrentStep(tabId, profile, resumeFile);
          if (rec.error) return finishLoop("error", rec.error);
          await focusPageAndFlush(tabId);
        }

        // Try to advance.
        setAutofill({ loopStatus: `Advancing from ${label}…` });
        const next = await tabSend(tabId, { type: "WD_NEXT" });
        if (next && next.advanced) {
          advanced = true;
          break;
        }

        // Didn't advance — re-validate; Workday likely just revealed errors on Save.
        await focusPageAndFlush(tabId);
        v = await tabSend(tabId, { type: "WD_VALIDATE" });
        if (v && !v.clean) {
          lastNames = (v.invalidFields || []).map((f) => f.label || f.key).filter(Boolean);
          console.warn(`[workday] auto-advance: ${label} post-save errors`, v.invalidFields);
          setAutofill({ loopStatus: `Resolving ${v.errorCount || ""} issue(s) on ${label}…` });
          const rec = await fillCurrentStep(tabId, profile, resumeFile);
          if (rec.error) return finishLoop("error", rec.error);
          // loop retries the Save with the freshly LLM-filled values
        } else {
          // No detectable error but it didn't move — maybe a slow navigation.
          await delay(1600);
          const d2 = await tabSend(tabId, { type: "WD_DETECT" });
          if (d2 && d2.step && d2.step !== step) {
            advanced = true;
            break;
          }
          console.warn(`[workday] auto-advance: ${label} did not advance and no errors detected (attempt ${attempt + 1})`);
        }
      }

      if (loopStopped()) return finishLoop("stopped");
      if (!advanced) {
        return finishLoop(
          "needs_user",
          lastNames.length ? `Couldn't resolve on ${label}: ${lastNames.join(", ")}` : `Couldn't advance past ${label} (no fixable errors detected).`
        );
      }
      const afterStep = await tabSend(tabId, { type: "WD_DETECT" });
      if (afterStep && afterStep.step === "review") return finishLoop("review");
      await delay(600);
    }
    return finishLoop("guard");
  } catch (err) {
    return finishLoop("error", (err && err.message) || String(err));
  }
}

function finishLoop(reason, error) {
  const messages = {
    review: "Reached the Review step — review and submit when you're ready.",
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

function stopAutoAdvance() {
  setAutofill({ loopStop: true, loopStatus: "Stopping…" });
}

// If no frame contains a Workday step, none reply — surface that after a wait.
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
      await chrome.tabs.sendMessage(af.tabId, { type: "AF_CLEAR" });
    } catch {
      /* tab may be gone */
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
      await chrome.tabs.sendMessage(tabId, { type: "AF_REMOVE", handle });
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
    await chrome.tabs.sendMessage(tabId, { type: "AF_START" });
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
  await delay(500);
}

// ApplyToJob (JazzHR): reveal the hidden resume file input before extraction so
// the engine claims it and the file driver can attach the resume PDF. Mirrors
// the Greenhouse education prep.
async function prepareApplyToJob(tabId) {
  if (tabId == null) return;
  await tabSend(tabId, { type: "AF_ATJ_PREP" });
  await delay(400);
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
// cached, marking it filled, so the harvest + LLM pass skips it — no menu
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
  const strat = s.application_answer_strategy || s.autofill_answer_strategy || s.answer_strategy;
  if (strat) prefs.answer_strategy = String(strat);
  const src = s.application_resume_source || s.resume_source;
  if (src) prefs.resume_source = String(src);
  return Object.keys(prefs).length ? prefs : undefined;
}

// Ask the content script(s) to extract structured specs for the selected blocks.
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
    if (tabId != null) {
      try {
        chrome.tabs.sendMessage(tabId, { type: "AF_EXTRACT" });
      } catch {
        /* ignore */
      }
    }
    // Generous timeout: harvesting custom-dropdown options involves opening them.
    setTimeout(finish, 4000);
  });
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
  for (const fileType of order) {
    if (fileType in cache) {
      if (cache[fileType]) return cache[fileType];
      continue;
    }
    try {
      cache[fileType] = await api.downloadResumeFile(jobId, fileType);
      return cache[fileType];
    } catch {
      cache[fileType] = null;
    }
  }
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
        chrome.tabs.sendMessage(tabId, { type: "AF_WRITE", passId, results, files });
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
        await chrome.tabs.sendMessage(tabId, { type: "AF_AUTOSELECT" });
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

  for (let pass = 0; pass < AUTOFILL_MAX_PASSES; pass++) {
    // Re-extract the live DOM each pass. Already-filled controls report
    // filled:true (and skip option harvesting); newly rendered controls show up.
    setAutofill({ runStatus: pass === 0 ? "Reading the application fields…" : "Checking for new fields…" });
    const specs = await extractSpecs(tabId, handles);
    if (!specs.length) {
      if (pass === 0 && isFirstPage) {
        setAutofill({ error: "Could not read the selected fields. Try reselecting." });
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

    for (const r of results) {
      for (const c of r.controls || []) {
        if (c.needs_user) {
          ctx.needsUser.push({ cid: c.cid, label: ctx.labelByCid[c.cid] || "Field", reason: c.reason || "Needs your input" });
        }
      }
    }

    const { files, missing } = await fetchFilesForResults(state.job.job_id, results, apiSpecs);
    for (const m of missing) {
      const roleLabel = m.role === "cover_letter" ? "Cover letter" : "Resume";
      const why =
        m.role === "cover_letter"
          ? "no cover letter file was generated for this job (set up a cover letter template and build it)"
          : "no resume file was generated for this job yet";
      ctx.needsUser.push({ cid: m.cid, label: roleLabel, reason: `Upload manually - ${why}` });
    }

    const writeCount = results.reduce((n, r) => n + (r.controls || []).length, 0);
    setAutofill({ runStatus: `Filling ${writeCount} field${writeCount === 1 ? "" : "s"} on the page…` });
    await writeAndWait(tabId, results, files);

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
    await new Promise((r) => setTimeout(r, 500));
  }

  // Final reconciliation for controlled forms (e.g. Ashby): a value can sit in
  // the DOM while the framework never recorded it — the early commit runs
  // before these fields are written, and the engine skips any control that
  // already holds a value, so a late/skipped write never fires React's
  // onChange and submit reports the field "missing". The browser also RE-applies
  // autofill to name/phone/company fields as focus moves during our writes, so a
  // value can appear after the last write. Let the page settle, then re-commit
  // every text field's CURRENT value through the React-safe path twice so a late
  // browser refill is still caught. It's idempotent (same text).
  if (eng && eng.mode === "select") {
    setAutofill({ runStatus: "Finalizing the form…" });
    await delay(400);
    await commitPrefilled(tabId);
    await delay(200);
    await commitPrefilled(tabId);
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

  return lastSpecs;
}

async function runAutofill() {
  if (!state.job || !state.autofill.fields.length || state.autofill.running) return;
  const tabId = state.autofill.tabId;
  // Clicking run leaves picking mode and clears the on-page selection outlines so
  // the page is clean while filling (control attributes are kept for the writer).
  if (tabId != null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "AF_STOP" });
      await chrome.tabs.sendMessage(tabId, { type: "AF_HIDE_MARKS" });
    } catch {
      /* ignore */
    }
  }
  setAutofill({ running: true, runStatus: "Preparing the form…", error: null, statuses: {}, needsUser: [], picking: false });
  try {
    const eng = state.autofill.engine;
    const ctx = { labelByCid: {}, needsUser: [] };
    let lastSpecs = await fillCurrentPage(tabId, eng, ctx, true);

    // SmartRecruiters: longer applications split across steps with a footer
    // "Next" button (the final step shows "Submit" instead). Fill the step, click
    // Next, re-discover the freshly rendered step, and fill again — repeating
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
  if (state.toast) root.appendChild(el("div", { class: "toast" }, state.toast));
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
  const wrap = el("div", { class: "screen" });
  wrap.appendChild(el("h1", {}, "Job Application Assistant"));
  wrap.appendChild(el("p", { class: "muted" }, "Sign in with your Job Scraper account."));

  const urlInput = el("input", { type: "text", id: "f-url", placeholder: "http://localhost:8000" });
  const emailInput = el("input", { type: "email", id: "f-email", placeholder: "you@example.com" });
  const passInput = el("input", { type: "password", id: "f-pass", placeholder: "Password" });

  store.getBackendUrl().then((u) => (urlInput.value = u));

  const form = el("form", {
    class: "form",
    onsubmit: (e) => {
      e.preventDefault();
      doLogin(urlInput.value, emailInput.value, passInput.value);
    },
  });
  form.appendChild(field("Server URL", urlInput));
  form.appendChild(field("Email", emailInput));
  form.appendChild(field("Password", passInput));
  form.appendChild(el("button", { type: "submit", class: "btn primary" }, "Sign in"));
  wrap.appendChild(form);
  if (state.error) wrap.appendChild(el("div", { class: "error" }, state.error));
  return wrap;
}

function field(label, input) {
  return el("label", { class: "field" }, [el("span", {}, label), input]);
}

function renderHome() {
  const wrap = el("div", { class: "screen" });
  wrap.appendChild(renderHeader());
  wrap.appendChild(renderPreferencesBar());

  if (state.sync) wrap.appendChild(renderSyncBanner());
  if (state.error) wrap.appendChild(el("div", { class: "error", onclick: () => setState({ error: null }) }, state.error));

  wrap.appendChild(renderProviderBadge());
  wrap.appendChild(renderJobTabs());
  wrap.appendChild(renderActiveTab());
  return wrap;
}

// Topic tabs across the top of Home: In progress / New today / Ready to apply.
function renderJobTabs() {
  const tabs = [
    { id: "progress", label: "In progress", count: state.sessions.length },
    { id: "today", label: "New today", count: state.todayQueue.length },
    { id: "ready", label: "Ready to apply", count: state.queue.length },
    { id: "applied", label: "Applied", count: state.appliedQueue.length },
  ];
  return el(
    "div",
    { class: "tabs" },
    tabs.map((t) =>
      el(
        "button",
        {
          class: "tab" + (t.id === state.homeTab ? " active" : ""),
          onclick: () => setState({ homeTab: t.id }),
        },
        [
          el("span", {}, t.label),
          state.queueLoading
            ? el("span", { class: "tab-count loading" }, el("span", { class: "spinner-sm" }))
            : el("span", { class: "tab-count" }, String(t.count)),
        ]
      )
    )
  );
}

function renderActiveTab() {
  switch (state.homeTab) {
    case "progress":
      return jobListSection(
        "progress",
        state.sessions.map((s) => {
          const snap = s.job_snapshot || {};
          return {
            title: s.job_title || snap.title || "(untitled job)",
            company: s.company || snap.company,
            score: snap.match_score,
            source: sourceFromUrl(s.job_url || snap.url),
            chips: sessionChips(s, snap),
            onClick: () => openJob(s.job_id, { redirect: true }),
          };
        }),
        "No applications in progress yet."
      );
    case "today":
      return jobListSection(
        "today",
        state.todayQueue.map((j) => ({
          title: j.title || "(untitled job)",
          company: j.company,
          score: j.match_overall_score,
          source: j.source || sourceFromUrl(j.normalized_url || j.source_url),
          chips: dashboardChips(j),
          onClick: () => openJob(j.id, { redirect: true }),
        })),
        "No new jobs were scraped today."
      );
    case "applied":
      return jobListSection(
        "applied",
        state.appliedQueue.map((j) => ({
          title: j.title || "(untitled job)",
          company: j.company,
          score: j.match_overall_score,
          source: j.source || sourceFromUrl(j.normalized_url || j.source_url),
          chips: appliedChips(j),
          onClick: () => openJob(j.id, { redirect: true }),
        })),
        "No jobs applied yet today."
      );
    case "ready":
    default: {
      const section = el("div", { class: "tab-panel" });
      section.appendChild(renderMinScoreControl());
      section.appendChild(
        jobListSection(
          "ready",
          state.queue.map((j) => ({
            title: j.title || "(untitled job)",
            company: j.company,
            score: j.match_overall_score,
            source: j.source || sourceFromUrl(j.normalized_url || j.source_url),
            chips: dashboardChips(j),
            onClick: () => openJob(j.id, { redirect: true }),
          })),
          `No jobs with a finished tailored resume and score of at least ${state.minScore}.`
        )
      );
      return section;
    }
  }
}

// ── job-card metadata helpers ────────────────────────────────────────────────

// Per-platform branding: label, brand color, and a short monogram for the logo
// avatar. The color also tints the card background + left accent stripe so the
// source is recognizable at a glance.
const SOURCE_META = {
  linkedin: { label: "LinkedIn", color: "#0A66C2", short: "in" },
  indeed: { label: "Indeed", color: "#2557A7", short: "ID" },
  greenhouse: { label: "Greenhouse", color: "#1F9F6E", short: "GH" },
  applytojob: { label: "ApplyToJob", color: "#13A6A6", short: "AT" },
  recruiterflow: { label: "RecruiterFlow", color: "#7C3AED", short: "RF" },
  workday: { label: "Workday", color: "#0875E1", short: "WD" },
  lever: { label: "Lever", color: "#6D6AE0", short: "LV" },
  ziprecruiter: { label: "ZipRecruiter", color: "#1C9CD8", short: "ZR" },
  glassdoor: { label: "Glassdoor", color: "#0CAA41", short: "GD" },
  dice: { label: "Dice", color: "#E4002B", short: "DC" },
  jobright: { label: "Jobright", color: "#6C5CE7", short: "JR" },
  wellfound: { label: "Wellfound", color: "#475569", short: "WF" },
  monster: { label: "Monster", color: "#6E46AE", short: "MO" },
  ashby: { label: "Ashby", color: "#4F46E5", short: "AB" },
  smartrecruiters: { label: "SmartRecruiters", color: "#0CA0E8", short: "SR" },
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
  if (u.includes("ashbyhq")) return "ashby";
  if (u.includes("smartrecruiters")) return "smartrecruiters";
  if (u.includes("linkedin.")) return "linkedin";
  if (u.includes("indeed.")) return "indeed";
  if (u.includes("ziprecruiter")) return "ziprecruiter";
  if (u.includes("glassdoor")) return "glassdoor";
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

function dashboardChips(j) {
  const chips = [];
  const posted = timeAgo(j.posted_date) || timeAgo(j.created_at);
  if (posted) chips.push({ label: posted });
  if (j.is_remote) chips.push({ label: "Remote", tone: "info" });
  // Docs-ready status — resume PDF is the artifact the autofill uploads.
  if (j.resume_pdf_status === "completed") chips.push({ label: "Resume", tone: "ok", dot: true });
  if (j.cover_letter_pdf_status === "completed") chips.push({ label: "Cover letter", tone: "ok", dot: true });
  return chips;
}

function appliedChips(j) {
  const chips = [];
  const when = timeAgo(j.applied_at);
  chips.push({ label: when ? `Applied ${when}` : "Applied", tone: "ok", dot: true });
  if (j.is_remote) chips.push({ label: "Remote", tone: "info" });
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
    // Don't show "nothing here" until we actually know — show skeletons instead.
    if (state.queueLoading) return renderSkeletonList();
    return el("p", { class: "muted" }, emptyMsg);
  }

  const size = state.pageSize || JOBS_PAGE_SIZES[0];
  const totalPages = Math.max(1, Math.ceil(cards.length / size));
  const page = Math.min(Math.max(1, (state.pageByTab && state.pageByTab[tabId]) || 1), totalPages);
  const start = (page - 1) * size;
  const pageCards = cards.slice(start, start + size);

  const wrap = el("div", { class: "tab-panel" });
  wrap.appendChild(renderPager(tabId, page, totalPages, cards.length, start, pageCards.length));
  const list = el("div", { class: "list" });
  pageCards.forEach((c) => list.appendChild(jobCard(c)));
  wrap.appendChild(list);
  return wrap;
}

function setTabPage(tabId, page) {
  setState({ pageByTab: { ...state.pageByTab, [tabId]: page } });
}

function applyPageSize(size) {
  setState({ pageSize: size, pageByTab: { progress: 1, today: 1, ready: 1, applied: 1 } });
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
      onchange: (e) => applyPageSize(parseInt(e.target.value, 10) || JOBS_PAGE_SIZES[0]),
    },
    JOBS_PAGE_SIZES.map((n) =>
      el("option", n === state.pageSize ? { value: String(n), selected: "selected" } : { value: String(n) }, `${n} / page`)
    )
  );

  const top = el("div", { class: "pager-top" }, [
    el("span", { class: "pager-info muted small" }, `${start + 1}–${start + shown} of ${total}`),
    sizer,
  ]);

  // Single page: still show the count + size selector, skip the number strip.
  if (totalPages <= 1) return el("div", { class: "pager" }, [top]);

  const navBtn = (label, target, { disabled = false, active = false, title } = {}) =>
    el(
      "button",
      {
        class: "page-btn" + (active ? " active" : ""),
        disabled,
        title: title || `Page ${target}`,
        onclick: () => setTabPage(tabId, target),
      },
      label
    );

  const nav = el("div", { class: "pager-nav" }, [
    navBtn("«", 1, { disabled: page <= 1, title: "First page" }),
    navBtn("‹", page - 1, { disabled: page <= 1, title: "Previous page" }),
    ...pageSequence(page, totalPages).map((p) =>
      p === "…"
        ? el("span", { class: "page-ellipsis" }, "…")
        : navBtn(String(p), p, { active: p === page })
    ),
    navBtn("›", page + 1, { disabled: page >= totalPages, title: "Next page" }),
    navBtn("»", totalPages, { disabled: page >= totalPages, title: "Last page" }),
  ]);

  return el("div", { class: "pager" }, [top, nav]);
}

function renderHeader() {
  return el("div", { class: "header" }, [
    el("div", { class: "header-title" }, "Assistant"),
    el("div", { class: "header-right" }, [
      el("span", { class: "muted small" }, state.user ? state.user.email : ""),
      el("button", { class: "btn link", onclick: () => doLogout() }, "Sign out"),
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
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_NEXT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
const ICON_FLAG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22V4"/></svg>';
const ICON_ALERT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
const ICON_DOC =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/></svg>';
const ICON_LIST =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/></svg>';
const ICON_STAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3 6.5 7 .9-5 4.7 1.3 7L12 18l-6.3 3.1L7 14.1l-5-4.7 7-.9z"/></svg>';
const ICON_CHIP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>';

function icon(svg, cls = "btn-ico") {
  return el("span", { class: cls, html: svg });
}

// Top-of-screen preferences. The auto-advance toggle controls whether Workday
// autofill drives the whole flow to the Review step or fills one step at a time.
function renderPreferencesBar() {
  const on = !!state.autoAdvance;
  const toggle = el(
    "button",
    {
      class: "switch" + (on ? " on" : ""),
      role: "switch",
      "aria-checked": on ? "true" : "false",
      title: "Automatically fill and advance each Workday step until the Review page.",
      onclick: () => applyAutoAdvance(!state.autoAdvance),
    },
    [el("span", { class: "switch-knob" })]
  );
  return el("div", { class: "prefs-bar" + (on ? " active" : "") }, [
    el("div", { class: "prefs-row" }, [
      el("span", { class: "prefs-icon" + (on ? " on" : ""), html: ICON_BOLT }),
      el("div", { class: "prefs-text" }, [
        el("span", { class: "prefs-label" }, "Auto-advance until submit ready"),
        el(
          "span",
          { class: "prefs-sub muted small" },
          "Fills each step, fixes validation, and clicks Continue. Stops at the Review page."
        ),
      ]),
      toggle,
    ]),
  ]);
}

const PROVIDER_LABELS = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini", google: "Google" };

function renderProviderBadge() {
  const settings = state.cache && state.cache.settings;
  if (!settings) return el("div", {});
  const provider = settings.llm_provider || "openai";
  const configured = !!settings[`${provider}_key_configured`];
  const name = PROVIDER_LABELS[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
  return el("div", { class: "provider-badge", title: configured ? "Using your configured API key" : "No key set, using the server default" }, [
    el("span", { class: "provider-label muted" }, "AI provider"),
    el("span", { class: "provider-name" }, name),
    el("span", { class: "provider-status " + (configured ? "ok" : "warn") }, [
      el("span", { class: "chip-dot" }),
      el("span", {}, configured ? "Key configured" : "Server default"),
    ]),
  ]);
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

function renderMinScoreControl() {
  const input = el("input", {
    type: "number",
    min: "0",
    max: "100",
    step: "1",
    class: "score-input",
    value: String(state.minScore),
  });
  const reloadBtn = el(
    "button",
    {
      class: "btn small primary",
      disabled: true,
      onclick: () => {
        const v = parseInt(input.value, 10);
        applyMinScore(Number.isFinite(v) ? v : store.DEFAULT_MIN_SCORE);
      },
    },
    "Reload"
  );
  // Reload is enabled only once the entered value differs from the applied one.
  input.addEventListener("input", () => {
    const v = parseInt(input.value, 10);
    reloadBtn.disabled = !(Number.isFinite(v) && v !== state.minScore);
  });
  return el("div", { class: "score-control" }, [
    el("label", { class: "score-label" }, "Min match score"),
    input,
    reloadBtn,
  ]);
}

const ICON_BRIEFCASE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/></svg>';

function jobCard({ title, company, score, onClick, badge, chips = [], source }) {
  const meta = sourceMeta(source);
  const side = [];
  if (score != null) side.push(el("span", { class: "score " + scoreClass(score) }, `${score}`));
  if (badge) side.push(el("span", { class: "badge tiny" }, badge));

  const logo = meta.short
    ? el("div", { class: "card-logo", title: meta.label || "" }, meta.short)
    : el("div", { class: "card-logo neutral", title: "Other source", html: ICON_BRIEFCASE });

  return el(
    "div",
    { class: "card", style: `--src-color:${meta.color}`, onclick: onClick },
    [
      logo,
      el("div", { class: "card-main" }, [
        el("div", { class: "card-title", title }, title),
        company ? el("div", { class: "card-sub muted", title: company }, company) : null,
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
    el("div", { class: "header" }, [
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
  wrap.appendChild(renderPreferencesBar());
  wrap.appendChild(el("h1", { class: "job-title" }, job.title || "(untitled job)"));
  wrap.appendChild(el("div", { class: "muted" }, job.company || ""));
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
  } else {
    wrap.appendChild(renderJdDetails(job.snapshot));
  }

  wrap.appendChild(renderChat(job));
  wrap.appendChild(renderJobFooter());
  if (state.error) wrap.appendChild(el("div", { class: "error", onclick: () => setState({ error: null }) }, state.error));
  return wrap;
}

function renderJdDetails(snap) {
  const details = el("details", { class: "jd", open: "open" });
  details.appendChild(
    el("summary", { class: "jd-summary" }, [icon(ICON_DOC, "jd-summary-ico"), el("span", {}, "Job description")])
  );
  const body = el("div", { class: "jd-body" });

  // Quick facts grid — only the fields that exist.
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

function renderChat(job) {
  const chat = el("div", { class: "chat" });
  const msgs = el("div", { class: "messages" });
  if (!job.messages.length) {
    msgs.appendChild(
      el("div", { class: "chat-empty muted" }, [
        icon(ICON_BOLT, "chat-empty-icon"),
        el("span", {}, "Ask anything about this application."),
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
        row.appendChild(
          el("button", { class: "copy-btn", title: "Copy answer", onclick: () => copyText(mdToPlain(m.content)) }, "Copy")
        );
      }
      msgs.appendChild(row);
    } else {
      msgs.appendChild(bubble);
    }
  });
  chat.appendChild(msgs);
  setTimeout(() => (msgs.scrollTop = msgs.scrollHeight), 0);

  // Controls
  const controls = el("div", { class: "controls" }, [
    labeledSelect("Tone", STYLES, state.style, (v) => setState({ style: v })),
    labeledSelect("Answer type", FIELD_TYPES, state.fieldType, (v) => setState({ fieldType: v })),
  ]);
  chat.appendChild(controls);

  const ta = el("textarea", {
    class: "composer-input",
    placeholder: "Ask the assistant…  (Enter to send, Shift+Enter for newline)",
    rows: 2,
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
    ? el("button", { class: "icon-btn stop", title: "Stop generating", onclick: () => stopStreaming() }, [icon(ICON_STOP), el("span", {}, "Stop")])
    : el("button", { class: "icon-btn primary", title: "Send (Enter)", onclick: send }, [icon(ICON_SEND), el("span", {}, "Ask")]);
  chat.appendChild(el("div", { class: "composer" }, [ta, sendBtn]));
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

function renderAutofillPanel() {
  const af = state.autofill;
  const wrap = el("div", { class: "autofill" });

  if (!af.active) {
    const previewEngine = state.job && state.job.engine;
    wrap.appendChild(
      el("button", { class: "btn primary autofill-btn", onclick: () => startAutofill() }, [
        icon(ICON_BOLT),
        el("span", {}, "Autofill this page"),
      ])
    );
    if (previewEngine) {
      const ok = previewEngine.available;
      wrap.appendChild(
        ok
          ? el("div", { class: "af-engine" }, [
              icon(ICON_CHIP, "af-engine-ico"),
              el("span", { class: "af-engine-label" }, "Engine"),
              el("span", { class: "af-engine-name" }, previewEngine.label),
            ])
          : el("div", { class: "af-engine warn" }, [
              icon(ICON_ALERT, "af-engine-ico"),
              el("span", {}, `${previewEngine.label} jobs get a dedicated engine (coming soon).`),
            ])
      );
    }
    return wrap;
  }

  // Deterministic engines (Workday) have a distinct panel: no picking / field
  // list — just run status and a per-step filled/missed report.
  if (af.engine && af.engine.mode === "workday") {
    return renderWorkdayPanel(af);
  }

  const engineLabel = af.engine ? ` - ${af.engine.label}` : "";
  const autoDiscover = !!(af.engine && af.engine.autoDiscover);
  const titleSuffix = af.discovering ? " - scanning" : af.picking ? " - selecting" : "";
  wrap.appendChild(
    el("div", { class: "autofill-head" }, [
      el("span", { class: "autofill-title" }, [
        icon(ICON_BOLT, "af-title-ico"),
        el("span", {}, "Autofill mode" + titleSuffix + engineLabel),
      ]),
      el("button", { class: "btn link", onclick: () => cancelAutofill() }, "Cancel"),
    ])
  );
  if (af.discovering) {
    wrap.appendChild(renderSpinner("Scanning the application form..."));
  } else if (af.picking) {
    wrap.appendChild(
      el(
        "p",
        { class: "muted small" },
        "Click each field block on the page. Green is one field, amber has several, red has no input. Press Esc to stop picking."
      )
    );
  } else if (!autoDiscover) {
    // Auto-discovery engines fill the whole form in one pass, so manual
    // "select more fields" only applies to the generic best-effort flow.
    wrap.appendChild(
      el("button", { class: "btn small", onclick: () => resumePicking() }, "Select more fields")
    );
  }

  if (af.fields.length) {
    const list = el("div", { class: "af-list" });
    af.fields.forEach((f) => {
      const status = blockStatus(f.handle);
      list.appendChild(
        el("div", { class: "af-item" }, [
          el("span", { class: `af-badge ${f.level}` }, afBadgeLabel(f.level)),
          el("span", { class: "af-label" }, f.label || "(field)"),
          status ? el("span", { class: `af-status ${status}` }, afStatusLabel(status)) : null,
          el("button", { class: "af-remove", title: "Remove", onclick: () => removeAutofillField(f.handle) }, "x"),
        ])
      );
    });
    wrap.appendChild(list);
  } else if (!af.discovering) {
    wrap.appendChild(el("p", { class: "muted small" }, "No fields selected yet."));
  }

  if (af.running) {
    wrap.appendChild(renderSpinner(af.runStatus || "Filling the application…"));
  } else if (!af.discovering) {
    wrap.appendChild(
      el(
        "button",
        { class: "btn small primary", disabled: !af.fields.length, onclick: () => runAutofill() },
        af.fields.length ? `Autofill ${af.fields.length} field${af.fields.length === 1 ? "" : "s"}` : "Autofill"
      )
    );
  }

  if (af.error) {
    wrap.appendChild(el("div", { class: "error", onclick: () => setAutofill({ error: null }) }, af.error));
  }

  if (af.needsUser && af.needsUser.length) {
    const n = af.needsUser.length;
    wrap.appendChild(
      el("div", { class: "af-needs" }, [
        el("div", { class: "af-needs-head" }, [
          icon(ICON_ALERT, "af-needs-ico"),
          el("span", { class: "af-needs-title" }, `Review ${n} field${n === 1 ? "" : "s"} manually`),
          el("span", { class: "af-needs-count" }, String(n)),
        ]),
        el("p", { class: "af-needs-sub" }, "We couldn't fill these from your profile — please check them before submitting."),
        el(
          "div",
          { class: "af-needs-list" },
          af.needsUser.map((item) =>
            el("div", { class: "af-needs-item" }, [
              el("span", { class: "af-needs-label" }, item.label || "Field"),
              el("span", { class: "af-needs-reason" }, item.reason || "Needs your input"),
            ])
          )
        ),
      ])
    );
  }

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
  wrap.appendChild(
    el("div", { class: "autofill-head" }, [
      el("span", { class: "autofill-title" }, [
        icon(ICON_BOLT, "af-title-ico"),
        el("span", {}, af.autoLoop ? "Workday auto-advance" : "Workday autofill"),
      ]),
      el(
        "button",
        { class: "btn link", onclick: () => (af.running && af.autoLoop ? stopAutoAdvance() : cancelAutofill()) },
        af.running ? "Stop" : "Close"
      ),
    ])
  );

  if (af.running && af.autoLoop) {
    wrap.appendChild(el("p", { class: "muted small" }, af.loopStatus || "Working through the application…"));
  } else if (af.running) {
    wrap.appendChild(el("p", { class: "muted small" }, "Filling the current step from your profile..."));
  } else if (af.autoLoop && af.done && af.loopMessage) {
    const cls = af.loopFinished === "review" ? "banner ok" : af.loopFinished === "error" || af.loopFinished === "needs_user" || af.loopFinished === "stuck" ? "banner warn" : "muted small";
    wrap.appendChild(el("div", { class: cls }, af.loopMessage));
  } else if (af.done && !af.reports.length && !af.error) {
    wrap.appendChild(
      el("p", { class: "muted small" }, "No Workday application step was detected on this page. Open the application and try again.")
    );
  } else if (!af.done) {
    wrap.appendChild(el("p", { class: "muted small" }, "Starting..."));
  }

  if (af.reports && af.reports.length) {
    const list = el("div", { class: "af-list" });
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
    wrap.appendChild(list);
    if (!af.autoLoop) {
      wrap.appendChild(
        el(
          "p",
          { class: "muted small" },
          "Review the page, then click Workday's Continue/Save and Continue. Re-run on each step. Submit is left to you."
        )
      );
    }
  }

  if (af.error) {
    wrap.appendChild(el("div", { class: "error", onclick: () => setAutofill({ error: null }) }, af.error));
  }

  if (af.done) {
    const loopMode = state.autoAdvance;
    wrap.appendChild(
      el(
        "button",
        { class: "btn small primary", onclick: () => rerunWorkday() },
        loopMode ? "Run again from this step" : "Fill this step again"
      )
    );
  }
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
      console.warn("[workday] resume PDF downloaded:", (resumeFile && resumeFile.filename) || "(unnamed)");
    } catch (e) {
      console.warn("[workday] resume PDF download failed:", (e && e.message) || e);
      resumeFile = null;
    }
    if (useLoop) {
      await autoAdvanceWorkday(tabId, profile, resumeFile);
      return;
    }
    await chrome.tabs.sendMessage(tabId, {
      type: "WD_RUN",
      profile,
      options: { autoAdvance: false, resumeFile },
    });
    armWorkdayWatchdog();
  } catch (err) {
    setAutofill({ running: false, done: true, error: (err && err.message) || String(err) });
  }
}

function renderJobFooter() {
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
    el("button", { class: "btn primary footer-btn", onclick: () => completeJob({ next: true }) }, [
      el("span", {}, "Complete & Next"),
      icon(ICON_NEXT),
    ]),
  ]);
}

init();
