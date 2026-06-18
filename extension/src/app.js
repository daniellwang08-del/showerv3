import * as api from "./api.js";
import * as store from "./store.js";

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
  queue: [],
  minScore: store.DEFAULT_MIN_SCORE,
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
    tabId: null,
    fields: [],
    specs: [],
    statuses: {},
    needsUser: [],
    running: false,
    error: null,
  };
}

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
  } else if (msg.type === "AF_PICKING_STOPPED") {
    if (state.autofill.picking) setAutofill({ picking: false });
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

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
  const [user, token, minScore] = await Promise.all([
    store.getCurrentUser(),
    store.getToken(),
    store.getMinScore(),
  ]);
  state.minScore = minScore;
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

async function loadQueue() {
  try {
    // Fetch the most-recently-added jobs (today's additions are at the top) and
    // filter client-side: added today, ready to apply, and at or above the
    // user's minimum match score.
    const [sessions, dash] = await Promise.all([
      api.listSessions("in_progress").catch(() => []),
      api.getDashboard({ per_page: 200, sort: "created_at", order: "desc" }).catch(() => ({ items: [] })),
    ]);
    const minScore = state.minScore;
    const today = startOfToday();
    const ready = (dash.items || []).filter((j) => {
      if (j.resume_build_status !== "completed") return false;
      if (j.applied_at) return false;
      if ((j.match_overall_score ?? -1) < minScore) return false;
      if (!j.created_at) return false;
      return new Date(j.created_at) >= today;
    });
    ready.sort((a, b) => (b.match_overall_score ?? 0) - (a.match_overall_score ?? 0));
    setState({ sessions: sessions || [], queue: ready });
  } catch (err) {
    setState({ error: err.message });
  }
}

async function applyMinScore(value) {
  const n = await store.setMinScore(value);
  setState({ minScore: n });
  await loadQueue();
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
        messages: detail.messages || [],
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
    // Host permission for the page must be requested on this user gesture.
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      toast("Permission to read this page was denied.");
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: "AUTOFILL_INJECT", tabId: tab.id });
    if (!res || !res.ok) {
      toast("Could not start autofill on this page.");
      return;
    }
    await chrome.tabs.sendMessage(tab.id, { type: "AF_START" });
    setState({ autofill: { ...emptyAutofill(), active: true, picking: true, tabId: tab.id } });
  } catch (err) {
    toast("Autofill could not start: " + ((err && err.message) || err));
  }
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
  setAutofill({ running: true, error: null, statuses: {}, needsUser: [], picking: false });
  try {
    const handles = state.autofill.fields.map((f) => f.handle);
    const attemptedKeys = new Set(); // stable control keys we've already sent to the LLM
    const labelByCid = {};
    const needsUser = [];
    let lastSpecs = [];

    for (let pass = 0; pass < AUTOFILL_MAX_PASSES; pass++) {
      // Re-extract the live DOM each pass. Already-filled controls report
      // filled:true (and skip option harvesting); newly rendered controls show up.
      const specs = await extractSpecs(tabId, handles);
      if (!specs.length) {
        if (pass === 0) {
          setAutofill({ running: false, error: "Could not read the selected fields. Try reselecting." });
          return;
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
          labelByCid[c.cid] = c.label || f.label || "Field";
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
            needsUser.push({ cid: c.cid, label: labelByCid[c.cid] || "Field", reason: c.reason || "Needs your input" });
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
        needsUser.push({ cid: m.cid, label: roleLabel, reason: `Upload manually - ${why}` });
      }

      await writeAndWait(tabId, results, files);
      // Give conditionally rendered fields a moment to mount before re-scanning.
      await new Promise((r) => setTimeout(r, 500));
    }

    setAutofill({ running: false, specs: lastSpecs, needsUser });
  } catch (err) {
    setAutofill({ running: false, error: (err && err.message) || "Autofill failed." });
  }
}

// ── rendering ────────────────────────────────────────────────────────────────

function render() {
  root.innerHTML = "";
  let view;
  if (state.view === "loading") view = el("div", { class: "center muted" }, "Loading...");
  else if (state.view === "login") view = renderLogin();
  else if (state.view === "home") view = renderHome();
  else if (state.view === "job") view = renderJob();
  root.appendChild(view);

  if (state.toast) root.appendChild(el("div", { class: "toast" }, state.toast));
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

  if (state.sync) wrap.appendChild(renderSyncBanner());
  if (state.error) wrap.appendChild(el("div", { class: "error", onclick: () => setState({ error: null }) }, state.error));

  wrap.appendChild(renderProviderBadge());

  // Resume in-progress sessions
  if (state.sessions && state.sessions.length) {
    wrap.appendChild(el("h2", {}, "In progress"));
    const list = el("div", { class: "list" });
    state.sessions.forEach((s) => {
      list.appendChild(
        jobCard({
          title: s.job_title || "(untitled job)",
          company: s.company,
          onClick: () => openJob(s.job_id, { redirect: false }),
          badge: "resume",
        })
      );
    });
    wrap.appendChild(list);
  }

  // Today's ready-to-apply queue, filtered by the minimum match score.
  wrap.appendChild(el("h2", {}, `Today's ready to apply (${state.queue.length})`));
  wrap.appendChild(renderMinScoreControl());
  if (!state.queue.length) {
    wrap.appendChild(
      el(
        "p",
        { class: "muted" },
        `No jobs added today with a finished tailored resume and score of at least ${state.minScore}.`
      )
    );
  } else {
    const list = el("div", { class: "list" });
    state.queue.forEach((j) => {
      list.appendChild(
        jobCard({
          title: j.title || "(untitled job)",
          company: j.company,
          score: j.match_overall_score,
          onClick: () => openJob(j.id, { redirect: true }),
        })
      );
    });
    wrap.appendChild(list);
  }
  return wrap;
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

function renderProviderBadge() {
  const settings = state.cache && state.cache.settings;
  if (!settings) return el("div", {});
  const provider = settings.llm_provider || "openai";
  const configured = settings[`${provider}_key_configured`];
  const badge = el("div", { class: "badge-row" }, [
    el("span", { class: "badge" }, `Provider: ${provider}`),
    el(
      "span",
      { class: "badge " + (configured ? "ok" : "warn") },
      configured ? "key configured" : "no key, using server default"
    ),
  ]);
  return badge;
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

function jobCard({ title, company, score, onClick, badge }) {
  return el("div", { class: "card", onclick: onClick }, [
    el("div", { class: "card-main" }, [
      el("div", { class: "card-title" }, title),
      el("div", { class: "card-sub muted" }, company || ""),
    ]),
    el("div", { class: "card-meta" }, [
      score != null ? el("span", { class: "score" }, `${score}`) : null,
      badge ? el("span", { class: "badge tiny" }, badge) : null,
    ]),
  ]);
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
    wrap.appendChild(el("div", { class: "center muted" }, "Loading job..."));
    if (state.error) wrap.appendChild(el("div", { class: "error" }, state.error));
    return wrap;
  }

  const job = state.job;
  wrap.appendChild(el("h1", { class: "job-title" }, job.title || "(untitled job)"));
  wrap.appendChild(el("div", { class: "muted" }, job.company || ""));
  wrap.appendChild(renderAutofillPanel());

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
  const details = el("details", { class: "jd" });
  details.appendChild(el("summary", {}, "Job description"));
  const body = el("div", { class: "jd-body" });
  const addList = (label, items) => {
    if (items && items.length) {
      body.appendChild(el("div", { class: "jd-label" }, label));
      const ul = el("ul", {});
      items.forEach((i) => ul.appendChild(el("li", {}, i)));
      body.appendChild(ul);
    }
  };
  if (snap.description) body.appendChild(el("p", {}, snap.description.slice(0, 1200)));
  addList("Requirements", snap.requirements);
  addList("Responsibilities", snap.responsibilities);
  addList("Benefits", snap.benefits);
  details.appendChild(body);
  return details;
}

function renderChat(job) {
  const chat = el("div", { class: "chat" });
  const msgs = el("div", { class: "messages" });
  if (!job.messages.length) {
    msgs.appendChild(el("div", { class: "muted center" }, "Ask anything about this application."));
  }
  job.messages.forEach((m) => {
    const bubble = el("div", { class: `msg ${m.role}` });
    bubble.innerHTML = escapeHtml(m.content).replace(/\n/g, "<br>") + (m._streaming ? '<span class="cursor">|</span>' : "");
    if (m.role === "assistant") {
      const row = el("div", { class: "msg-row assistant" }, [bubble]);
      if (!m._streaming) {
        // Copy reads the message's current text so what you copy is exactly what you see.
        row.appendChild(
          el("button", { class: "copy-btn", title: "Copy answer", onclick: () => copyText(m.content) }, "Copy")
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
    selectEl(STYLES, state.style, (v) => setState({ style: v })),
    selectEl(FIELD_TYPES, state.fieldType, (v) => setState({ fieldType: v })),
  ]);
  chat.appendChild(controls);

  const ta = el("textarea", { placeholder: "Ask the assistant (Enter to send, Shift+Enter for newline)", rows: 2 });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const v = ta.value;
      ta.value = "";
      askQuestion(v);
    }
  });
  const sendBtn = state.streaming
    ? el("button", { class: "btn", onclick: () => stopStreaming() }, "Stop")
    : el("button", { class: "btn primary", onclick: () => { const v = ta.value; ta.value = ""; askQuestion(v); } }, "Ask");
  chat.appendChild(el("div", { class: "composer" }, [ta, sendBtn]));
  return chat;
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
    wrap.appendChild(
      el("button", { class: "btn small", onclick: () => startAutofill() }, "Autofill this page")
    );
    return wrap;
  }

  wrap.appendChild(
    el("div", { class: "autofill-head" }, [
      el("span", { class: "autofill-title" }, af.picking ? "Autofill mode - selecting" : "Autofill mode"),
      el("button", { class: "btn link", onclick: () => cancelAutofill() }, "Cancel"),
    ])
  );
  if (af.picking) {
    wrap.appendChild(
      el(
        "p",
        { class: "muted small" },
        "Click each field block on the page. Green is one field, amber has several, red has no input. Press Esc to stop picking."
      )
    );
  } else {
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
  } else {
    wrap.appendChild(el("p", { class: "muted small" }, "No fields selected yet."));
  }

  const runBtn = af.running
    ? el("button", { class: "btn small", disabled: true }, "Filling...")
    : el(
        "button",
        { class: "btn small primary", disabled: !af.fields.length, onclick: () => runAutofill() },
        af.fields.length ? `Autofill ${af.fields.length} field${af.fields.length === 1 ? "" : "s"}` : "Autofill"
      );
  wrap.appendChild(runBtn);

  if (af.error) {
    wrap.appendChild(el("div", { class: "error", onclick: () => setAutofill({ error: null }) }, af.error));
  }

  if (af.needsUser && af.needsUser.length) {
    wrap.appendChild(
      el("div", { class: "af-needs" }, [
        el("div", { class: "af-needs-title" }, "Review these manually"),
        ...af.needsUser.map((n) => el("div", { class: "af-needs-item" }, `${n.label}: ${n.reason}`)),
      ])
    );
  }

  return wrap;
}

function renderJobFooter() {
  return el("div", { class: "footer" }, [
    el("button", { class: "btn", onclick: () => completeJob({ next: false }) }, "Complete & Exit"),
    el("button", { class: "btn primary", onclick: () => completeJob({ next: true }) }, "Complete & Next"),
  ]);
}

init();
