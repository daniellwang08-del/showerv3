// Auto-apply console: picks ready-to-apply jobs in the order the user chose and
// runs several applications at once. Each application runs in its own hidden
// runner iframe (runner.js); this page schedules them, hands out the shared
// window focus, and keeps the history so a job is not attempted twice.

import * as api from "../api.js";
import * as storage from "../storage.js";
import { html, render, useEffect, useState } from "../lib/preact.js";
import { Badge, Banner, Button, Empty, IconButton, Modal, Score, Segmented, Spinner, Toggle } from "../panel/ui/components.js";
import { Icon } from "../panel/ui/icons.js";
import {
  ORDERS,
  STAGES,
  appliedToday,
  arrangeQueue,
  easeLabel,
  easeTier,
  filterHistory,
  formatDuration,
  isWaiting,
  nextRunnable,
  stageIndex,
  stageOf,
  successStats,
  timeAgo,
} from "./model.js";
import { DEFAULT_SUBMIT_PLATFORMS, EASE_TIER, NEEDS_ACCOUNT, PLATFORM_LABEL, rankJobs } from "./platforms.js";

const SETTINGS_KEY = "aaSettings";
const HISTORY_KEY = "aaHistory";
const HISTORY_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;
const FOCUS_HOLD_MS = 4500;
const READY_PAGES = 3;
const LOG_MAX = 120;
const QUEUE_SHOWN = 60;

const FILL_PLATFORMS = Object.keys(EASE_TIER);
const ALL_PLATFORMS = [...FILL_PLATFORMS, ...NEEDS_ACCOUNT, "board"].sort((a, b) => easeTier(a) - easeTier(b));
const RECOMMENDED_FILL = FILL_PLATFORMS.filter((p) => p !== "generic" && p !== "bamboohr");

const DEFAULT_SETTINGS = {
  parallel: 3,
  dryRun: true,
  dailyCap: 25,
  maxWaiting: 10,
  closeOnSuccess: true,
  platforms: RECOMMENDED_FILL,
  submitPlatforms: DEFAULT_SUBMIT_PLATFORMS,
  order: "ease",
  minScore: 0,
  perCompany: 0,
  runTimeoutMin: 14,
  showGuide: true,
};

// ── store ───────────────────────────────────────────────────────────────────

let store = {
  user: null,
  backendUrl: "",
  mail: null,
  settings: DEFAULT_SETTINGS,
  history: {},
  // Every ready job not yet attempted, ranked, on any site. The queue is the
  // part of it on enabled sites, minus skips, in the chosen order.
  available: [],
  pinned: [],
  skipped: [],
  runs: {},
  phase: "idle", // idle | running | paused
  loading: false,
  loadedAt: 0,
  notice: null,
  windowId: null,
  log: [],
  modal: null,
};
const listeners = new Set();

function set(patch) {
  store = { ...store, ...(typeof patch === "function" ? patch(store) : patch) };
  for (const fn of listeners) fn(store);
}

function useStore() {
  const [snap, setSnap] = useState(store);
  useEffect(() => {
    listeners.add(setSnap);
    setSnap(store);
    return () => listeners.delete(setSnap);
  }, []);
  return snap;
}

function useNow(fast) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [fast]);
  return now;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const label = (p) => PLATFORM_LABEL[p] || p || "Unknown site";

function log(tone, text) {
  set((s) => ({ log: [{ id: `${Date.now()}-${Math.random()}`, at: Date.now(), tone, text }, ...s.log].slice(0, LOG_MAX) }));
}

function notify(tone, text) {
  set({ notice: { tone, text } });
  log(tone, text);
}

function queueOf(s) {
  const enabled = new Set(s.settings.platforms);
  const skipped = new Set(s.skipped);
  return arrangeQueue(
    s.available.filter((q) => enabled.has(q.platform) && !skipped.has(q.id)),
    { order: s.settings.order, minScore: s.settings.minScore, pinned: s.pinned },
  );
}

function waitingOnYou(history, runs) {
  const open = Object.values(history).filter((h) => (h.status === "needs_you" || h.status === "filled") && h.tabOpen).length;
  return open + Object.values(runs).filter((r) => r.status === "needs_you").length;
}

async function saveSettings(patch) {
  const settings = { ...store.settings, ...patch };
  set({ settings });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  if (store.phase === "running") pump();
}

async function saveHistory(history) {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  const kept = Object.fromEntries(Object.entries(history).filter(([, h]) => h.at >= cutoff));
  set({ history: kept });
  await chrome.storage.local.set({ [HISTORY_KEY]: kept });
}

// ── runner hooks (called from runner iframes) ───────────────────────────────

let focusChain = Promise.resolve();
const otpWaiting = new Set();
const frames = new Map();
const timers = new Map();

window.naoAutoApply = {
  config() {
    return {
      dryRun: store.settings.dryRun,
      submitPlatforms: store.settings.submitPlatforms,
      windowId: store.windowId,
    };
  },
  update(jobId, patch) {
    set((s) => (s.runs[jobId] ? { runs: { ...s.runs, [jobId]: { ...s.runs[jobId], ...patch } } } : {}));
  },
  finish(jobId, outcome) {
    void finishRun(jobId, outcome);
  },
  // Some engines need the page to have OS focus for a moment; runs take turns.
  focusTab(tabId) {
    const turn = focusChain.then(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.tabs.update(tabId, { active: true });
      } catch {
        /* tab or window closed */
      }
      await delay(350);
    });
    focusChain = turn.then(() => delay(FOCUS_HOLD_MS));
    return turn;
  },
  otpWait(jobId, on) {
    if (on) otpWaiting.add(jobId);
    else otpWaiting.delete(jobId);
  },
  otpWaiters() {
    return otpWaiting.size;
  },
};

// ── scheduling ──────────────────────────────────────────────────────────────

async function ensureWindow() {
  if (store.windowId != null) {
    try {
      await chrome.windows.get(store.windowId);
      return store.windowId;
    } catch {
      /* closed by the user */
    }
  }
  const win = await chrome.windows.create({ focused: false, state: "normal", width: 1280, height: 900 });
  set({ windowId: win.id });
  return win.id;
}

async function loadQueue() {
  set({ loading: true });
  try {
    const rows = [];
    for (let page = 1; page <= READY_PAGES; page++) {
      const data = await api.getJobs({ view: "ready", page, per_page: 200, sort: "created_at", order: "desc" });
      const items = (data && data.items) || [];
      rows.push(...items);
      if (!items.length || rows.length >= Number((data && data.total) || 0)) break;
    }
    const attempted = new Set(Object.keys(store.history).filter((id) => store.history[id].status !== "failed"));
    for (const id of Object.keys(store.runs)) attempted.add(id);
    const available = rankJobs(rows, { allowed: new Set(ALL_PLATFORMS), skip: attempted });
    set({ available, loading: false, loadedAt: Date.now() });
    return available;
  } catch (err) {
    set({ loading: false });
    notify("danger", (err && err.message) || "Could not load ready jobs.");
    return [];
  }
}

function pump() {
  if (store.phase !== "running") return;
  const { settings } = store;
  while (Object.keys(store.runs).length < settings.parallel) {
    const queue = queueOf(store);
    if (!queue.length) break;
    if (!settings.dryRun && appliedToday(store.history) + submittingCount() >= settings.dailyCap) {
      pause(`Daily limit of ${settings.dailyCap} applications reached. Raise it or come back tomorrow.`, "warn");
      return;
    }
    if (waitingOnYou(store.history, store.runs) >= settings.maxWaiting) {
      pause(`${settings.maxWaiting} applications are waiting on you. Finish some, then resume.`, "warn");
      return;
    }
    const idx = nextRunnable(queue, { history: store.history, runs: store.runs, perCompany: settings.perCompany });
    if (idx < 0) {
      if (!Object.keys(store.runs).length) {
        set({ phase: "idle" });
        notify("info", "The remaining jobs are held back by the per-company limit for today.");
      }
      return;
    }
    startRun(queue[idx]);
  }
  if (!Object.keys(store.runs).length && !queueOf(store).length) {
    set({ phase: "idle" });
    notify("ok", "Queue finished.");
  }
}

function submittingCount() {
  return Object.values(store.runs).filter((r) => r.submittedAt).length;
}

function startRun(job) {
  set((s) => ({
    available: s.available.filter((q) => q.id !== job.id),
    pinned: s.pinned.filter((id) => id !== job.id),
    runs: { ...s.runs, [job.id]: { ...job, status: "running", message: "Starting...", startedAt: Date.now() } },
  }));
  log("info", `Started ${job.title}${job.company ? ` at ${job.company}` : ""} (${label(job.platform)}).`);
  const frame = document.createElement("iframe");
  frame.src = `autoapply-runner.html?job=${encodeURIComponent(job.id)}`;
  frame.hidden = true;
  frames.set(job.id, frame);
  document.body.appendChild(frame);
  const limitMin = store.settings.runTimeoutMin;
  timers.set(
    job.id,
    setTimeout(
      () => void finishRun(job.id, { status: "needs_you", message: `Took longer than ${limitMin} minutes. The page is left open for you.` }),
      limitMin * 60_000,
    ),
  );
}

async function rememberHandOff(tabId, jobId) {
  // The background watches this tab and marks the job applied when the user submits.
  try {
    const { applyTabJobs } = await chrome.storage.session.get("applyTabJobs");
    await chrome.storage.session.set({
      applyTabJobs: { ...(applyTabJobs || {}), [String(tabId)]: { jobId, at: Date.now() } },
      ["aaHandoff:" + tabId]: { jobId, at: Date.now() },
    });
  } catch {
    /* advisory */
  }
  // Not every fill engine leaves the submit watcher on the page.
  await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, files: ["content/submit-watch.js"] })
    .catch(() => {});
}

const OUTCOME_TONE = { applied: "ok", filled: "info", needs_you: "warn", skipped: "muted", failed: "danger" };

async function finishRun(jobId, outcome) {
  const run = store.runs[jobId];
  if (!run) return;
  clearTimeout(timers.get(jobId));
  timers.delete(jobId);
  const frame = frames.get(jobId);
  if (frame) frame.remove();
  frames.delete(jobId);
  otpWaiting.delete(jobId);

  const tabId = outcome.tabId != null ? outcome.tabId : run.tabId;
  const status = outcome.status || "failed";
  let tabOpen = tabId != null;
  if (status === "applied" && tabId != null && store.settings.closeOnSuccess) {
    await chrome.tabs.remove(tabId).catch(() => {});
    tabOpen = false;
  } else if ((status === "needs_you" || status === "filled" || status === "failed") && tabId != null) {
    await chrome.storage.session.remove("aaTab:" + tabId).catch(() => {});
    await rememberHandOff(tabId, jobId);
  } else if (tabId != null && status === "skipped") {
    await chrome.tabs.remove(tabId).catch(() => {});
    tabOpen = false;
  }

  const entry = {
    status,
    message: outcome.message || "",
    at: Date.now(),
    startedAt: run.startedAt,
    title: run.title,
    company: run.company,
    platform: run.platform,
    score: run.score,
    url: run.url,
    tabId,
    tabOpen,
  };
  const runs = { ...store.runs };
  delete runs[jobId];
  set({ runs });
  log(OUTCOME_TONE[status] || "muted", `${STATUS[status] ? STATUS[status].label : status}: ${run.title}. ${entry.message}`.trim());
  await saveHistory({ ...store.history, [jobId]: entry });
  if (store.phase === "paused" && !Object.keys(store.runs).length) notify("info", "Paused. Running applications have finished.");
  pump();
}

function stopRun(jobId) {
  void finishRun(jobId, { status: "needs_you", message: "Stopped by you. The page is left as it was." });
}

function pause(message, tone = "info") {
  set({ phase: "paused" });
  if (message) notify(tone, message);
}

function stopAll(message) {
  set({ phase: "idle", pinned: [] });
  for (const jobId of Object.keys(store.runs)) {
    void finishRun(jobId, { status: "needs_you", message: "Stopped. The page is left as it was." });
  }
  if (message) notify("warn", message);
}

async function start() {
  // Must be the first await: the permission prompt needs the click's gesture.
  const granted = await chrome.permissions.request({ origins: ["*://*/*"] }).catch(() => false);
  if (!granted) {
    notify("danger", "Auto-apply needs access to job sites to fill applications.");
    return;
  }
  set({ phase: "running", notice: null });
  log("info", store.settings.dryRun ? "Started in dry run: forms are filled, never submitted." : "Started live: applications are submitted.");
  try {
    await ensureWindow();
  } catch {
    set({ windowId: null });
  }
  await loadQueue();
  if (!queueOf(store).length && !Object.keys(store.runs).length) {
    set({ phase: "idle" });
    notify("info", "No ready-to-apply jobs match these settings.");
    return;
  }
  pump();
}

function resume() {
  set({ phase: "running", notice: null });
  log("info", "Resumed.");
  pump();
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch {
    return false;
  }
}

async function openEntry(jobId) {
  const h = store.history[jobId];
  if (!h) return;
  if (h.tabId != null && (await focusTab(h.tabId))) return;
  if (h.url) {
    const tab = await chrome.tabs.create({ url: h.url, active: true });
    await rememberHandOff(tab.id, jobId);
    await saveHistory({ ...store.history, [jobId]: { ...h, tabId: tab.id, tabOpen: true } });
  }
}

async function markEntryApplied(jobId) {
  const h = store.history[jobId];
  try {
    await api.markApplied([jobId]);
    api.updateSession(jobId, "completed").catch(() => {});
    await saveHistory({ ...store.history, [jobId]: { ...h, status: "applied", message: "Marked applied by you.", at: Date.now(), tabOpen: false } });
    if (h && h.tabId != null) await chrome.tabs.remove(h.tabId).catch(() => {});
    log("ok", `Marked applied: ${h ? h.title : "job"}.`);
  } catch (err) {
    notify("danger", (err && err.message) || "Could not mark it applied.");
  }
}

async function forgetEntry(jobId) {
  const history = { ...store.history };
  delete history[jobId];
  await saveHistory(history);
  await loadQueue();
}

async function clearFinished() {
  const kept = Object.fromEntries(Object.entries(store.history).filter(([, h]) => isWaiting(h) || h.status === "applied"));
  await saveHistory(kept);
  set({ modal: null });
  log("info", "Cleared finished attempts. Skipped and failed jobs can be tried again.");
  await loadQueue();
}

function pinNext(id) {
  set((s) => ({ pinned: [id, ...s.pinned.filter((p) => p !== id)], skipped: s.skipped.filter((x) => x !== id) }));
  if (store.phase === "running") pump();
}

function skipJob(id) {
  set((s) => ({ skipped: [...s.skipped, id], pinned: s.pinned.filter((p) => p !== id) }));
}

function setLive(live) {
  if (!live) return void saveSettings({ dryRun: true });
  set({
    modal: {
      title: "Submit applications for real?",
      message: `Auto-apply will press Submit on the sites you allow, up to ${store.settings.dailyCap} a day. Dry run only fills forms so you can review them first.`,
      confirmLabel: "Turn on live mode",
      onConfirm: () => {
        set({ modal: null });
        void saveSettings({ dryRun: false });
        log("warn", "Live mode on: applications will be submitted.");
      },
    },
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const hit = Object.entries(store.history).find(([, h]) => h.tabId === tabId && h.tabOpen);
  if (hit) void saveHistory({ ...store.history, [hit[0]]: { ...hit[1], tabOpen: false } });
});

// The user submitted a handed-off tab: the background marked it applied and
// rewrote the history.
chrome.storage.local.onChanged.addListener((changes) => {
  const next = changes[HISTORY_KEY] && changes[HISTORY_KEY].newValue;
  if (next) set({ history: next });
});

// ── UI ──────────────────────────────────────────────────────────────────────

const STATUS = {
  running: { tone: "brand", label: "Working" },
  applied: { tone: "ok", label: "Applied" },
  filled: { tone: "brand", label: "Filled" },
  needs_you: { tone: "warn", label: "Needs you" },
  skipped: { tone: "muted", label: "Skipped" },
  failed: { tone: "danger", label: "Failed" },
};

function StatusBadge({ status }) {
  const s = STATUS[status] || STATUS.failed;
  return html`<${Badge} tone=${s.tone} dot=${status === "running"}>${s.label}</${Badge}>`;
}

function PlatformChip({ platform }) {
  return html`<span class=${`aa-chip aa-tier-${Math.min(easeTier(platform), 5)}`} title=${`${label(platform)}: ${easeLabel(platform)}`}>${label(platform)}</span>`;
}

function Card({ title, icon, meta, action, children, class: cls = "", hint }) {
  return html`<section class=${`aa-card ${cls}`}>
    ${title
      ? html`<header class="aa-card-head">
          <div class="aa-card-heading">
            ${icon ? html`<span class="aa-card-icon"><${Icon} name=${icon} size=${15} /></span>` : null}
            <div>
              <h2>${title}${meta != null ? html` <span class="aa-card-meta">${meta}</span>` : null}</h2>
              ${hint ? html`<p class="aa-card-hint">${hint}</p>` : null}
            </div>
          </div>
          ${action ? html`<div class="aa-card-action">${action}</div>` : null}
        </header>`
      : null}
    ${children}
  </section>`;
}

function RangeField({ label: text, hint, value, min, max, step = 1, format = (v) => String(v), onChange, disabled }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const pct = ((draft - min) / (max - min)) * 100;
  return html`<label class=${`aa-range${disabled ? " is-disabled" : ""}`}>
    <span class="aa-range-top">
      <span class="aa-range-label">${text}</span>
      <span class="aa-range-value">${format(draft)}</span>
    </span>
    <input
      type="range"
      min=${min}
      max=${max}
      step=${step}
      value=${draft}
      disabled=${disabled}
      style=${`--pct:${pct}%`}
      onInput=${(e) => setDraft(Number(e.currentTarget.value))}
      onChange=${(e) => onChange(Number(e.currentTarget.value))}
    />
    ${hint ? html`<span class="aa-range-hint">${hint}</span>` : null}
  </label>`;
}

function Field({ label: text, hint, children }) {
  return html`<div class="aa-field">
    <span class="aa-range-label">${text}</span>
    ${children}
    ${hint ? html`<span class="aa-range-hint">${hint}</span>` : null}
  </div>`;
}

function Meter({ value, max, tone = "brand" }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return html`<span class=${`aa-meter aa-meter-${tone}`} role="progressbar" aria-valuenow=${value} aria-valuemax=${max}>
    <span style=${`width:${pct}%`}></span>
  </span>`;
}

function Stat({ icon, label: text, value, sub, tone = "brand", meter }) {
  return html`<div class=${`aa-stat aa-stat-${tone}`}>
    <span class="aa-stat-icon"><${Icon} name=${icon} size=${16} /></span>
    <div class="aa-stat-body">
      <span class="aa-stat-label">${text}</span>
      <span class="aa-stat-value">${value}</span>
      ${meter || null}
      ${sub ? html`<span class="aa-stat-sub">${sub}</span>` : null}
    </div>
  </div>`;
}

function PhasePill({ phase, dryRun, busy, slots }) {
  const meta = {
    idle: { cls: "idle", text: "Idle" },
    running: { cls: "running", text: `Running, ${busy} of ${slots} slots busy` },
    paused: { cls: "paused", text: busy ? `Pausing, finishing ${busy}` : "Paused" },
  }[phase];
  return html`<span class="aa-pills">
    <span class=${`aa-phase aa-phase-${meta.cls}`}><i></i>${meta.text}</span>
    <span class=${`aa-mode-tag${dryRun ? "" : " is-live"}`}>${dryRun ? "Dry run" : "Live"}</span>
  </span>`;
}

function Header({ s }) {
  const busy = Object.keys(s.runs).length;
  const queued = queueOf(s).length;
  return html`<header class="aa-top">
    <div class="aa-brand">
      <img src="icons/icon48.png" alt="" width="28" height="28" />
      <div>
        <h1>Auto-apply</h1>
        <${PhasePill} phase=${s.phase} dryRun=${s.settings.dryRun} busy=${busy} slots=${s.settings.parallel} />
      </div>
    </div>
    <div class="aa-top-controls">
      <div class=${`aa-mode${s.phase !== "idle" ? " is-locked" : ""}`} title=${s.phase !== "idle" ? "Stop auto-apply to change the mode." : ""}>
        <span class="aa-mode-label">Mode</span>
        <${Segmented}
          label="Mode"
          value=${s.settings.dryRun ? "dry" : "live"}
          options=${[
            { value: "dry", label: "Dry run" },
            { value: "live", label: "Live" },
          ]}
          onChange=${(v) => s.phase === "idle" && setLive(v === "live")}
        />
      </div>
      ${!s.settings.showGuide
        ? html`<${Button} variant="ghost" icon="info" onClick=${() => void saveSettings({ showGuide: true })}>How it works</${Button}>`
        : null}
      ${s.phase === "idle"
        ? html`<${Button} variant="primary" icon="play" busy=${s.loading} disabled=${!queued && !s.loading && s.loadedAt > 0} onClick=${() => void start()}>
            Start${queued ? ` (${queued})` : ""}
          </${Button}>`
        : html`
            ${s.phase === "running"
              ? html`<${Button} variant="secondary" icon="pause" onClick=${() => pause("Pausing: running applications will finish, no new ones start.")}>Pause</${Button}>`
              : html`<${Button} variant="primary" icon="play" onClick=${resume}>Resume</${Button}>`}
            <${Button} variant="danger" icon="stop" onClick=${() => stopAll("Stopped. Open tabs are left as they were.")}>Stop</${Button}>
          `}
    </div>
  </header>`;
}

const GUIDE = [
  { icon: "layers", title: "Pick", text: "Takes jobs whose tailored resume is ready, in the order and filters you set." },
  { icon: "wand", title: "Fill", text: "Opens each in a background tab and fills it from your profile and documents." },
  { icon: "send", title: "Submit", text: "Live mode submits on the sites you allow and enters emailed codes when your inbox is connected." },
  { icon: "flag", title: "Hand off", text: "Anything it cannot finish stays open in its tab under Waiting on you." },
];

function Guide() {
  return html`<section class="aa-guide" aria-label="How auto-apply works">
    <ol>
      ${GUIDE.map(
        (g, i) => html`<li>
          <span class="aa-guide-icon"><${Icon} name=${g.icon} size=${16} /></span>
          <div>
            <p class="aa-guide-title"><span>${i + 1}</span>${g.title}</p>
            <p class="aa-guide-text">${g.text}</p>
          </div>
        </li>`,
      )}
    </ol>
    <${IconButton} icon="x" label="Hide this guide" size=${14} onClick=${() => void saveSettings({ showGuide: false })} />
  </section>`;
}

function Stats({ s }) {
  const queue = queueOf(s);
  const enabled = new Set(s.settings.platforms);
  const onSites = s.available.filter((q) => enabled.has(q.platform)).length;
  const hidden = onSites - queue.length;
  const sites = new Set(queue.map((q) => q.platform)).size;
  const busy = Object.keys(s.runs).length;
  const today = appliedToday(s.history);
  const waiting = Object.values(s.history).filter(isWaiting).length;
  const openTabs = waitingOnYou(s.history, s.runs);
  const week = successStats(s.history);
  const offSites = s.available.length - onSites;
  return html`<div class="aa-stats">
    <${Stat}
      icon="layers"
      label="Ready to apply"
      value=${s.loading && !s.loadedAt ? html`<${Spinner} size=${16} />` : queue.length}
      sub=${hidden > 0
        ? `${hidden} hidden by your filters`
        : offSites > 0
          ? `${offSites} more on sites that are off`
          : sites
            ? `Across ${sites} site${sites === 1 ? "" : "s"}`
            : "Build resumes to add more"}
    />
    <${Stat}
      icon="bolt"
      label="Running now"
      value=${html`${busy}<small> / ${s.settings.parallel}</small>`}
      meter=${html`<span class="aa-slots">${Array.from({ length: s.settings.parallel }, (_, i) => html`<i class=${i < busy ? "is-on" : ""}></i>`)}</span>`}
      sub=${s.phase === "running" ? "Applications at once" : s.phase === "paused" ? "Paused" : "Not running"}
    />
    <${Stat}
      icon="check"
      tone="ok"
      label="Applied today"
      value=${html`${today}<small> / ${s.settings.dailyCap}</small>`}
      meter=${html`<${Meter} value=${today} max=${s.settings.dailyCap} tone="ok" />`}
      sub=${s.settings.dryRun ? "Dry run submits nothing" : `${Math.max(0, s.settings.dailyCap - today)} left today`}
    />
    <${Stat}
      icon="flag"
      tone=${waiting ? "warn" : "muted"}
      label="Waiting on you"
      value=${waiting}
      meter=${html`<${Meter} value=${openTabs} max=${s.settings.maxWaiting} tone="warn" />`}
      sub=${`${openTabs} of ${s.settings.maxWaiting} open tabs before pausing`}
    />
    <${Stat}
      icon="chart"
      tone="info"
      label="Success, last 7 days"
      value=${week.rate == null ? "-" : `${week.rate}%`}
      sub=${week.attempts ? `${week.applied} applied of ${week.attempts} tried` : "No attempts yet"}
    />
  </div>`;
}

function RunSettings({ s }) {
  const st = s.settings;
  const order = ORDERS.find((o) => o.value === st.order) || ORDERS[0];
  return html`<${Card} title="Run settings" icon="settings" hint="Changes apply to the next application that starts.">
    <div class="aa-form">
      <${Field} label="Order" hint=${order.hint}>
        <${Segmented}
          label="Queue order"
          value=${st.order}
          options=${[
            { value: "ease", label: "Easiest" },
            { value: "match", label: "Best match" },
            { value: "newest", label: "Newest" },
          ]}
          onChange=${(v) => void saveSettings({ order: v })}
        />
      </${Field}>
      <${RangeField}
        label="Minimum match score"
        hint="Jobs below this score, or not scored yet, stay out of the queue."
        value=${st.minScore}
        min=${0}
        max=${95}
        step=${5}
        format=${(v) => (v ? `${v}+` : "Any")}
        onChange=${(v) => void saveSettings({ minScore: v })}
      />
      <${RangeField}
        label="Applications at once"
        hint="More is faster; each one runs in its own background tab."
        value=${st.parallel}
        min=${1}
        max=${5}
        onChange=${(v) => void saveSettings({ parallel: v })}
      />
      <${RangeField}
        label="Daily limit"
        hint="Submitted applications per day. Live mode stops here."
        value=${st.dailyCap}
        min=${1}
        max=${200}
        onChange=${(v) => void saveSettings({ dailyCap: v })}
      />
      <${RangeField}
        label="Pause when waiting on you"
        hint="Stops starting new ones while this many need your hand."
        value=${st.maxWaiting}
        min=${1}
        max=${50}
        onChange=${(v) => void saveSettings({ maxWaiting: v })}
      />
      <${RangeField}
        label="Time limit per application"
        hint="After this, the tab is handed to you."
        value=${st.runTimeoutMin}
        min=${5}
        max=${30}
        format=${(v) => `${v} min`}
        onChange=${(v) => void saveSettings({ runTimeoutMin: v })}
      />
      <${Field} label="Per company per day" hint="Spreads applications so one employer does not get many at once.">
        <${Segmented}
          label="Applications per company per day"
          value=${String(st.perCompany)}
          options=${[
            { value: "0", label: "No limit" },
            { value: "1", label: "1" },
            { value: "2", label: "2" },
            { value: "3", label: "3" },
          ]}
          onChange=${(v) => void saveSettings({ perCompany: Number(v) })}
        />
      </${Field}>
      <div class="aa-toggles">
        <${Toggle}
          label="Close tabs after applying"
          hint="Keeps the window tidy; failed and waiting tabs stay open."
          checked=${st.closeOnSuccess}
          onChange=${(v) => void saveSettings({ closeOnSuccess: v })}
        />
      </div>
    </div>
  </${Card}>`;
}

function SiteRow({ id, st, count, disabled }) {
  const fill = st.platforms.includes(id);
  const manual = NEEDS_ACCOUNT.has(id) || id === "board";
  const submit = fill && !manual && st.submitPlatforms.includes(id);
  const toggle = (key, on) => {
    const list = new Set(st[key]);
    if (on) list.add(id);
    else list.delete(id);
    void saveSettings({ [key]: [...list] });
  };
  return html`<div class=${`aa-site${fill ? " is-on" : ""}`}>
    <div class="aa-site-name">
      <span class="aa-site-title">${label(id)}</span>
      <span class=${`aa-ease aa-tier-${Math.min(easeTier(id), 5)}`}>${easeLabel(id)}</span>
      ${count ? html`<span class="aa-site-count" title=${`${count} ready`}>${count}</span>` : null}
    </div>
    <label class="aa-switch" title=${manual ? "Opens the page for you to finish" : "Fill the form"}>
      <input type="checkbox" class="toggle" checked=${fill} disabled=${disabled} onChange=${(e) => toggle("platforms", e.currentTarget.checked)} />
      <span>Fill</span>
    </label>
    ${manual
      ? html`<span class="aa-site-manual">Opens for you</span>`
      : html`<label class="aa-switch" title="Submit automatically in live mode">
          <input type="checkbox" class="toggle" checked=${submit} disabled=${disabled || !fill} onChange=${(e) => toggle("submitPlatforms", e.currentTarget.checked)} />
          <span>Submit</span>
        </label>`}
  </div>`;
}

function Sites({ s }) {
  const st = s.settings;
  const counts = s.available.reduce((m, q) => ((m[q.platform] = (m[q.platform] || 0) + 1), m), {});
  const disabled = s.phase !== "idle";
  const preset = (platforms, submitPlatforms) => void saveSettings({ platforms, submitPlatforms });
  return html`<${Card}
    title="Sites"
    icon="globe"
    meta=${`${st.platforms.length} on`}
    hint="Fill opens and completes the form. Submit sends it in live mode. Sites are listed easiest first."
  >
    <div class="aa-presets">
      <${Button} size="sm" variant="ghost" disabled=${disabled} onClick=${() => preset(RECOMMENDED_FILL, DEFAULT_SUBMIT_PLATFORMS)}>Recommended</${Button}>
      <${Button} size="sm" variant="ghost" disabled=${disabled} onClick=${() => preset(ALL_PLATFORMS, DEFAULT_SUBMIT_PLATFORMS)}>All sites</${Button}>
      <${Button} size="sm" variant="ghost" disabled=${disabled} onClick=${() => preset(st.platforms, [])}>Never submit</${Button}>
      <${Button} size="sm" variant="ghost" disabled=${disabled} onClick=${() => preset([], [])}>None</${Button}>
    </div>
    <div class="aa-sites">
      ${ALL_PLATFORMS.map((id) => html`<${SiteRow} key=${id} id=${id} st=${st} count=${counts[id] || 0} disabled=${disabled} />`)}
    </div>
    ${disabled ? html`<p class="aa-card-hint aa-pad">Stop auto-apply to change sites.</p>` : null}
  </${Card}>`;
}

function Stepper({ stage }) {
  const at = stageIndex(stage);
  return html`<ol class="aa-steps" aria-label=${`Step ${at + 1} of ${STAGES.length}: ${STAGES[at].label}`}>
    ${STAGES.map((st, i) => html`<li class=${i < at ? "is-done" : i === at ? "is-now" : ""}><i></i><span>${st.label}</span></li>`)}
  </ol>`;
}

function LiveRuns({ s, now }) {
  const runs = Object.entries(s.runs).sort((a, b) => a[1].startedAt - b[1].startedAt);
  return html`<${Card}
    title="Live"
    icon="bolt"
    meta=${runs.length ? `${runs.length} running` : null}
    hint="Each application runs in a background tab in the auto-apply window."
  >
    ${runs.length
      ? html`<div class="aa-runs">
          ${runs.map(([id, r]) => {
            const stage = stageOf(r);
            return html`<article class="aa-run" key=${id}>
              <div class="aa-run-head">
                <div class="aa-run-title">
                  <strong title=${r.title}>${r.title}</strong>
                  <span>${r.company || "Company not listed"}</span>
                </div>
                <${Score} value=${r.score >= 0 ? r.score : null} />
              </div>
              <div class="aa-run-meta">
                <${PlatformChip} platform=${r.platform} />
                <span class="aa-run-time"><${Icon} name="clock" size=${12} />${formatDuration(now - r.startedAt)}</span>
              </div>
              <${Stepper} stage=${stage} />
              <p class="aa-run-msg" title=${r.message}>${r.message || "Working..."}</p>
              <div class="aa-run-actions">
                ${r.tabId != null ? html`<${Button} size="sm" icon="external" onClick=${() => void focusTab(r.tabId)}>View tab</${Button}>` : null}
                <${Button} size="sm" variant="ghost" icon="x" onClick=${() => stopRun(id)}>Stop this one</${Button}>
              </div>
            </article>`;
          })}
        </div>`
      : html`<${Empty} icon="bolt" title=${s.phase === "running" ? "Starting..." : "Nothing running"}>
          ${s.phase === "idle" ? "Press Start to work through the queue. You can pause or stop at any time." : "Waiting for the next job in the queue."}
        </${Empty}>`}
  </${Card}>`;
}

function Queue({ s }) {
  const [q, setQ] = useState("");
  const queue = queueOf(s);
  const term = q.trim().toLowerCase();
  const shown = term
    ? queue.filter((j) => [j.title, j.company, label(j.platform)].some((v) => String(v || "").toLowerCase().includes(term)))
    : queue;
  const pinned = new Set(s.pinned);
  return html`<${Card}
    title="Queue"
    icon="list"
    meta=${queue.length}
    hint=${ORDERS.find((o) => o.value === s.settings.order)?.label + (s.settings.minScore ? `, match ${s.settings.minScore}+` : "")}
    action=${html`<div class="aa-card-tools">
      <label class="aa-search">
        <${Icon} name="search" size=${14} />
        <input type="search" placeholder="Filter queue" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} aria-label="Filter queue" />
      </label>
      <${IconButton} icon="refresh" label="Reload ready jobs" disabled=${s.loading} onClick=${() => void loadQueue()} />
    </div>`}
  >
    ${s.skipped.length
      ? html`<p class="aa-card-hint aa-pad">
          ${s.skipped.length} skipped for this session.
          <button type="button" class="aa-link" onClick=${() => set({ skipped: [] })}>Bring them back</button>
        </p>`
      : null}
    ${shown.length
      ? html`<div class="aa-table" role="table" aria-label="Queued jobs">
          ${shown.slice(0, QUEUE_SHOWN).map(
            (j, i) => html`<div class=${`aa-tr${pinned.has(j.id) ? " is-pinned" : ""}`} role="row" key=${j.id}>
              <span class="aa-td aa-td-num">${pinned.has(j.id) ? html`<${Icon} name="pin" size=${12} />` : i + 1}</span>
              <span class="aa-td aa-td-main">
                <strong title=${j.title}>${j.title}</strong>
                <span>${j.company || "Company not listed"}</span>
              </span>
              <span class="aa-td"><${PlatformChip} platform=${j.platform} /></span>
              <span class="aa-td"><${Score} value=${j.score >= 0 ? j.score : null} /></span>
              <span class="aa-td aa-td-actions">
                <${IconButton} icon="bolt" label="Run next" size=${14} disabled=${pinned.has(j.id) && i === 0} onClick=${() => pinNext(j.id)} />
                <${IconButton} icon="external" label="Open posting" size=${14} onClick=${() => void chrome.tabs.create({ url: j.url })} />
                <${IconButton} icon="x" label="Skip for this session" size=${14} onClick=${() => skipJob(j.id)} />
              </span>
            </div>`,
          )}
        </div>
        ${shown.length > QUEUE_SHOWN ? html`<p class="aa-card-hint aa-pad">And ${shown.length - QUEUE_SHOWN} more.</p>` : null}`
      : html`<${Empty} icon="inbox" title=${s.loading ? "Loading ready jobs..." : term ? "No match" : "Queue is empty"}>
          ${s.loading
            ? null
            : term
              ? "Nothing in the queue matches that filter."
              : "Jobs appear here once their tailored resume is built. Turn on more sites or lower the minimum score to include more."}
        </${Empty}>`}
  </${Card}>`;
}

function Waiting({ s, now }) {
  const waiting = Object.entries(s.history)
    .filter(([, h]) => isWaiting(h))
    .sort((a, b) => b[1].at - a[1].at);
  return html`<${Card} title="Waiting on you" icon="flag" meta=${waiting.length} hint="Finish these in their tabs. Submitting one marks it applied.">
    ${waiting.length
      ? html`<div class="aa-list">
          ${waiting.map(
            ([id, h]) => html`<article class="aa-item" key=${id}>
              <div class="aa-item-top">
                <${StatusBadge} status=${h.status} />
                <span class="aa-item-time">${timeAgo(h.at, now)}</span>
              </div>
              <strong class="aa-item-title" title=${h.title}>${h.title}</strong>
              <span class="aa-item-sub">${h.company || ""}${h.company && h.platform ? " · " : ""}${h.platform ? label(h.platform) : ""}</span>
              ${h.message ? html`<p class="aa-item-msg">${h.message}</p>` : null}
              <div class="aa-item-actions">
                <${Button} size="sm" variant="primary" icon="external" onClick=${() => void openEntry(id)}>${h.tabOpen ? "Go to tab" : "Open"}</${Button}>
                <${Button} size="sm" icon="check" onClick=${() => void markEntryApplied(id)}>Mark applied</${Button}>
                <${Button} size="sm" variant="ghost" icon="refresh" onClick=${() => void forgetEntry(id)}>Retry</${Button}>
              </div>
            </article>`,
          )}
        </div>`
      : html`<${Empty} icon="check" title="All clear">Applications that need a CAPTCHA, an account, or an answer from you show up here.</${Empty}>`}
  </${Card}>`;
}

const HISTORY_FILTERS = ["all", "applied", "filled", "needs_you", "failed", "skipped"];

function History({ s, now }) {
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const all = Object.entries(s.history)
    .filter(([, h]) => !isWaiting(h))
    .sort((a, b) => b[1].at - a[1].at);
  const counts = all.reduce((m, [, h]) => ((m[h.status] = (m[h.status] || 0) + 1), m), {});
  const rows = filterHistory(all, { status, q }).slice(0, 100);
  return html`<${Card}
    title="History"
    icon="history"
    meta=${all.length}
    hint="Kept for 45 days. Jobs here are not attempted again unless you retry them."
    action=${html`<div class="aa-card-tools">
      <label class="aa-search">
        <${Icon} name="search" size=${14} />
        <input type="search" placeholder="Search history" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} aria-label="Search history" />
      </label>
      <${Button}
        size="sm"
        variant="ghost"
        disabled=${!all.some(([, h]) => h.status !== "applied")}
        onClick=${() =>
          set({
            modal: {
              title: "Clear finished attempts?",
              message: "Skipped, failed and filled jobs are removed from history and can be tried again. Applied jobs are kept.",
              confirmLabel: "Clear",
              tone: "danger",
              onConfirm: () => void clearFinished(),
            },
          })}
      >Clear</${Button}>
    </div>`}
  >
    <div class="aa-filters" role="tablist" aria-label="Filter history">
      ${HISTORY_FILTERS.map((f) => {
        const n = f === "all" ? all.length : counts[f] || 0;
        if (f !== "all" && !n) return null;
        return html`<button type="button" role="tab" aria-selected=${status === f} class=${status === f ? "is-on" : ""} onClick=${() => setStatus(f)}>
          ${f === "all" ? "All" : STATUS[f].label}<span>${n}</span>
        </button>`;
      })}
    </div>
    ${rows.length
      ? html`<div class="aa-table" role="table" aria-label="Finished applications">
          ${rows.map(
            ([id, h]) => html`<div class="aa-tr" role="row" key=${id}>
              <span class="aa-td aa-td-status"><${StatusBadge} status=${h.status} /></span>
              <span class="aa-td aa-td-main">
                <strong title=${h.title}>${h.title || "Job"}</strong>
                <span title=${h.message}>${h.company ? `${h.company} · ` : ""}${h.message || ""}</span>
              </span>
              <span class="aa-td">${h.platform ? html`<${PlatformChip} platform=${h.platform} />` : null}</span>
              <span class="aa-td aa-td-time">${timeAgo(h.at, now)}</span>
              <span class="aa-td aa-td-actions">
                ${h.url ? html`<${IconButton} icon="external" label="Open posting" size=${14} onClick=${() => void chrome.tabs.create({ url: h.url })} />` : null}
                ${h.status !== "applied" ? html`<${IconButton} icon="refresh" label="Retry" size=${14} onClick=${() => void forgetEntry(id)} />` : null}
              </span>
            </div>`,
          )}
        </div>`
      : html`<${Empty} icon="history" title=${all.length ? "No match" : "No finished applications yet"}>
          ${all.length ? "Try another filter or search." : "Finished attempts appear here with what happened."}
        </${Empty}>`}
  </${Card}>`;
}

function Activity({ s }) {
  return html`<${Card} title="Activity" icon="clock" hint="What auto-apply did in this window.">
    ${s.log.length
      ? html`<ol class="aa-log">
          ${s.log.map(
            (e) => html`<li key=${e.id} class=${`aa-log-${e.tone}`}>
              <time>${new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
              <span>${e.text}</span>
            </li>`,
          )}
        </ol>`
      : html`<p class="aa-card-hint aa-pad">Nothing yet. Events show up here as auto-apply works.</p>`}
  </${Card}>`;
}

function Notices({ s }) {
  return html`
    ${s.notice ? html`<${Banner} tone=${s.notice.tone === "muted" ? "info" : s.notice.tone} onDismiss=${() => set({ notice: null })}>${s.notice.text}</${Banner}>` : null}
    ${s.mail && !s.mail.connected
      ? html`<${Banner} tone="info">
          Your inbox is not connected, so applications that email a verification code will wait for you. Connect it on the NAO Interviews page.
        </${Banner}>`
      : null}
  `;
}

function App() {
  const s = useStore();
  const now = useNow(Object.keys(s.runs).length > 0);

  if (!s.user) {
    return html`<main class="aa-signed-out">
      <${Empty} icon="logout" title="Sign in to use auto-apply">
        Open the NAO side panel, sign in, then reload this page.
      </${Empty}>
      <${Button} variant="primary" icon="refresh" onClick=${() => location.reload()}>Reload</${Button}>
    </main>`;
  }

  return html`<div class="aa-shell">
    <${Header} s=${s} />
    <main class="aa-main">
      ${s.settings.showGuide ? html`<${Guide} />` : null}
      <${Notices} s=${s} />
      <${Stats} s=${s} />
      <div class="aa-layout">
        <aside class="aa-side">
          <${RunSettings} s=${s} />
          <${Sites} s=${s} />
        </aside>
        <div class="aa-center">
          <${LiveRuns} s=${s} now=${now} />
          <${Queue} s=${s} />
          <${History} s=${s} now=${now} />
        </div>
        <aside class="aa-rail">
          <${Waiting} s=${s} now=${now} />
          <${Activity} s=${s} />
        </aside>
      </div>
    </main>
    <${Modal} modal=${s.modal} onClose=${() => set({ modal: null })} />
  </div>`;
}

async function init() {
  const [user, token, backendUrl, saved] = await Promise.all([
    storage.getCurrentUser(),
    storage.getToken(),
    storage.getBackendUrl(),
    chrome.storage.local.get([SETTINGS_KEY, HISTORY_KEY]),
  ]);
  set({
    user: user && token ? user : null,
    backendUrl,
    settings: { ...DEFAULT_SETTINGS, ...(saved[SETTINGS_KEY] || {}) },
    history: saved[HISTORY_KEY] || {},
  });
  if (!user || !token) return;
  api.apiFetch("/mail/config").then((mail) => set({ mail }), () => set({ mail: null }));
  void loadQueue();
}

render(html`<${App} />`, document.getElementById("app"));
void init();
