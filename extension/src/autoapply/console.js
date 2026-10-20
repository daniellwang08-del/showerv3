// Auto-apply console: picks ready-to-apply jobs, easiest ATS first, and runs
// several applications at once. Each application runs in its own hidden
// runner iframe (runner.js); this page schedules them, hands out the shared
// window focus, and keeps the history so a job is not attempted twice.

import * as api from "../api.js";
import * as storage from "../storage.js";
import { html, render, useEffect, useState } from "../lib/preact.js";
import { Badge, Banner, Button, Section, Toggle } from "../panel/ui/components.js";
import { DEFAULT_SUBMIT_PLATFORMS, EASE_TIER, NEEDS_ACCOUNT, PLATFORM_LABEL, rankJobs } from "./platforms.js";

const SETTINGS_KEY = "aaSettings";
const HISTORY_KEY = "aaHistory";
const HISTORY_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;
const RUN_TIMEOUT_MS = 14 * 60_000;
const FOCUS_HOLD_MS = 4500;
const READY_PAGES = 3;

const FILL_PLATFORMS = Object.keys(EASE_TIER);

const DEFAULT_SETTINGS = {
  parallel: 3,
  dryRun: true,
  dailyCap: 25,
  maxWaiting: 10,
  closeOnSuccess: true,
  platforms: FILL_PLATFORMS.filter((p) => p !== "generic" && p !== "bamboohr"),
  submitPlatforms: DEFAULT_SUBMIT_PLATFORMS,
};

// ── store ───────────────────────────────────────────────────────────────────

let store = {
  user: null,
  backendUrl: "",
  mail: null,
  settings: DEFAULT_SETTINGS,
  history: {},
  queue: [],
  runs: {},
  running: false,
  loading: false,
  notice: null,
  windowId: null,
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function appliedToday(history) {
  const since = startOfToday();
  return Object.values(history).filter((h) => h.status === "applied" && h.at >= since).length;
}

function waitingOnYou(history, runs) {
  const open = Object.values(history).filter((h) => (h.status === "needs_you" || h.status === "filled") && h.tabOpen).length;
  return open + Object.values(runs).filter((r) => r.status === "needs_you").length;
}

async function saveSettings(patch) {
  const settings = { ...store.settings, ...patch };
  set({ settings });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
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
  set({ loading: true, notice: null });
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
    const queue = rankJobs(rows, { allowed: new Set(store.settings.platforms), skip: attempted });
    set({ queue, loading: false });
    return queue;
  } catch (err) {
    set({ loading: false, notice: { tone: "danger", text: (err && err.message) || "Could not load ready jobs." } });
    return [];
  }
}

function pump() {
  if (!store.running) return;
  const { settings } = store;
  while (Object.keys(store.runs).length < settings.parallel && store.queue.length) {
    if (!settings.dryRun && appliedToday(store.history) + submittingCount() >= settings.dailyCap) {
      stopAll(`Daily limit of ${settings.dailyCap} applications reached.`);
      return;
    }
    if (waitingOnYou(store.history, store.runs) >= settings.maxWaiting) {
      set({ notice: { tone: "warn", text: `Paused: ${settings.maxWaiting} applications are waiting on you. Finish some, then press Start again.` } });
      stopAll(null);
      return;
    }
    const [next, ...rest] = store.queue;
    set({ queue: rest });
    startRun(next);
  }
  if (!Object.keys(store.runs).length && !store.queue.length) {
    set({ running: false, notice: { tone: "ok", text: "Queue finished." } });
  }
}

function submittingCount() {
  return Object.values(store.runs).filter((r) => r.submittedAt).length;
}

function startRun(job) {
  set((s) => ({
    runs: { ...s.runs, [job.id]: { ...job, status: "running", message: "Starting…", startedAt: Date.now() } },
  }));
  const frame = document.createElement("iframe");
  frame.src = `autoapply-runner.html?job=${encodeURIComponent(job.id)}`;
  frame.hidden = true;
  frames.set(job.id, frame);
  document.body.appendChild(frame);
  timers.set(
    job.id,
    setTimeout(() => void finishRun(job.id, { status: "needs_you", message: "Took too long. The page is left open for you." }), RUN_TIMEOUT_MS)
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
    title: run.title,
    company: run.company,
    platform: run.platform,
    url: run.url,
    tabId,
    tabOpen,
  };
  const runs = { ...store.runs };
  delete runs[jobId];
  set({ runs });
  await saveHistory({ ...store.history, [jobId]: entry });
  pump();
}

function stopAll(message) {
  for (const jobId of Object.keys(store.runs)) {
    void finishRun(jobId, { status: "needs_you", message: "Stopped. The page is left as it was." });
  }
  set({ running: false, ...(message ? { notice: { tone: "warn", text: message } } : {}) });
}

async function start() {
  // Must be the first await: the permission prompt needs the click's gesture.
  const granted = await chrome.permissions.request({ origins: ["*://*/*"] }).catch(() => false);
  if (!granted) {
    set({ notice: { tone: "danger", text: "Auto-apply needs access to job sites to fill applications." } });
    return;
  }
  set({ running: true, notice: null });
  try {
    await ensureWindow();
  } catch {
    set({ windowId: null });
  }
  const queue = await loadQueue();
  if (!queue.length && !Object.keys(store.runs).length) {
    set({ running: false, notice: { tone: "info", text: "No ready-to-apply jobs match these settings." } });
    return;
  }
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
  } catch (err) {
    set({ notice: { tone: "danger", text: (err && err.message) || "Could not mark it applied." } });
  }
}

async function forgetEntry(jobId) {
  const history = { ...store.history };
  delete history[jobId];
  await saveHistory(history);
  await loadQueue();
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
  running: { tone: "info", label: "Working" },
  applied: { tone: "ok", label: "Applied" },
  filled: { tone: "info", label: "Filled" },
  needs_you: { tone: "warn", label: "Needs you" },
  skipped: { tone: "muted", label: "Skipped" },
  failed: { tone: "danger", label: "Failed" },
};

function StatusBadge({ status }) {
  const s = STATUS[status] || STATUS.failed;
  return html`<${Badge} tone=${s.tone} dot=${status === "running"}>${s.label}</${Badge}>`;
}

function NumberField({ label, value, min, max, onChange, hint }) {
  return html`<label class="aa-num">
    <span class="aa-num-copy"><span class="toggle-label">${label}</span>${hint ? html`<span class="toggle-hint">${hint}</span>` : null}</span>
    <input type="number" min=${min} max=${max} value=${value} onChange=${(e) => {
      const n = Math.max(min, Math.min(max, Number(e.currentTarget.value) || min));
      onChange(n);
    }} />
  </label>`;
}

function PlatformPicker({ settings, disabled }) {
  const all = [...FILL_PLATFORMS, ...NEEDS_ACCOUNT, "board"];
  const toggle = (key, id, on) => {
    const list = new Set(settings[key]);
    if (on) list.add(id);
    else list.delete(id);
    void saveSettings({ [key]: [...list] });
  };
  return html`<table class="aa-platforms">
    <thead><tr><th>Site</th><th>Fill</th><th>Auto-submit</th></tr></thead>
    <tbody>
      ${all.map((id) => {
        const fill = settings.platforms.includes(id);
        const canSubmit = !NEEDS_ACCOUNT.has(id) && id !== "board";
        return html`<tr>
          <td>${PLATFORM_LABEL[id] || id}${NEEDS_ACCOUNT.has(id) || id === "board" ? html` <span class="aa-dim">(opens for you)</span>` : null}</td>
          <td><input type="checkbox" disabled=${disabled} checked=${fill} onChange=${(e) => toggle("platforms", id, e.currentTarget.checked)} /></td>
          <td>${canSubmit
            ? html`<input type="checkbox" disabled=${disabled || !fill} checked=${fill && settings.submitPlatforms.includes(id)} onChange=${(e) => toggle("submitPlatforms", id, e.currentTarget.checked)} />`
            : html`<span class="aa-dim">-</span>`}</td>
        </tr>`;
      })}
    </tbody>
  </table>`;
}

function JobLine({ item, children }) {
  return html`<div class="aa-row">
    <div class="aa-row-main">
      <div class="aa-row-title">${item.title || "Job"}${item.company ? html` <span class="aa-dim">at ${item.company}</span>` : null}</div>
      <div class="aa-row-meta">${PLATFORM_LABEL[item.platform] || item.platform || ""}${item.message ? html` · ${item.message}` : null}</div>
    </div>
    <div class="aa-row-side">${children}</div>
  </div>`;
}

function App() {
  const s = useStore();
  const { settings } = s;
  const runs = Object.entries(s.runs);
  const history = Object.entries(s.history).sort((a, b) => b[1].at - a[1].at);
  const isWaiting = (h) => h.status === "needs_you" || h.status === "filled" || (h.status === "failed" && h.tabOpen);
  const waiting = history.filter(([, h]) => isWaiting(h));
  const done = history.filter(([, h]) => !isWaiting(h)).slice(0, 40);
  const counts = s.queue.reduce((m, q) => ((m[q.platform] = (m[q.platform] || 0) + 1), m), {});

  if (!s.user) {
    return html`<main class="aa-page"><h1>Auto-apply</h1>
      <${Banner} tone="warn">Sign in to the NAO extension first (open the side panel), then reload this page.</${Banner}></main>`;
  }

  return html`<main class="aa-page">
    <header class="aa-head">
      <div>
        <h1>Auto-apply</h1>
        <p class="aa-dim">Fills and submits ready-to-apply jobs on its own, easiest sites first. Anything it cannot finish stays open in a tab for you.</p>
      </div>
      <div class="aa-actions">
        ${s.running
          ? html`<${Button} variant="secondary" icon="x" onClick=${() => stopAll("Stopped.")}>Stop</${Button}>`
          : html`<${Button} variant="primary" icon="wand" busy=${s.loading} onClick=${() => void start()}>Start</${Button}>`}
      </div>
    </header>

    ${s.notice ? html`<${Banner} tone=${s.notice.tone} onDismiss=${() => set({ notice: null })}>${s.notice.text}</${Banner}>` : null}
    ${settings.dryRun ? html`<${Banner} tone="info">Dry run is on: applications are filled but never submitted. Turn it off to submit automatically.</${Banner}>` : null}
    ${s.mail && !s.mail.connected
      ? html`<${Banner} tone="info">Your inbox is not connected, so applications that email a verification code will wait for you. Connect it on the NAO Interviews page.</${Banner}>`
      : null}

    <div class="aa-grid">
      <div class="aa-col">
        <${Section} title="Settings">
          <div class="aa-card">
            <${Toggle} label="Dry run" hint="Fill only, never press Submit." checked=${settings.dryRun} disabled=${s.running} onChange=${(v) => void saveSettings({ dryRun: v })} />
            <${NumberField} label="Applications at once" min=${1} max=${5} value=${settings.parallel} onChange=${(v) => void saveSettings({ parallel: v })} />
            <${NumberField} label="Daily limit" hint="Submitted applications per day." min=${1} max=${200} value=${settings.dailyCap} onChange=${(v) => void saveSettings({ dailyCap: v })} />
            <${NumberField} label="Pause after" hint="Applications waiting on you." min=${1} max=${50} value=${settings.maxWaiting} onChange=${(v) => void saveSettings({ maxWaiting: v })} />
            <${Toggle} label="Close tabs after applying" checked=${settings.closeOnSuccess} onChange=${(v) => void saveSettings({ closeOnSuccess: v })} />
          </div>
        </${Section}>
        <${Section} title="Sites" meta="Easiest first">
          <div class="aa-card"><${PlatformPicker} settings=${settings} disabled=${s.running} /></div>
        </${Section}>
      </div>

      <div class="aa-col aa-col-wide">
        <${Section} title="Now" meta=${`${runs.length} running · ${s.queue.length} queued · ${appliedToday(s.history)} applied today`}>
          <div class="aa-card">
            ${runs.length
              ? runs.map(([id, r]) => html`<${JobLine} key=${id} item=${r}>
                  <${StatusBadge} status=${r.status} />
                  ${r.tabId != null ? html`<${Button} size="sm" onClick=${() => void focusTab(r.tabId)}>View</${Button}>` : null}
                </${JobLine}>`)
              : html`<p class="aa-dim">${s.running ? "Starting…" : "Not running."}</p>`}
            ${Object.keys(counts).length
              ? html`<p class="aa-queue">Queued: ${Object.entries(counts).map(([p, n]) => `${PLATFORM_LABEL[p] || p} ${n}`).join(", ")}</p>`
              : null}
          </div>
        </${Section}>

        <${Section} title="Waiting on you" meta=${String(waiting.length)}>
          <div class="aa-card">
            ${waiting.length
              ? waiting.map(([id, h]) => html`<${JobLine} key=${id} item=${h}>
                  <${StatusBadge} status=${h.status} />
                  <${Button} size="sm" onClick=${() => void openEntry(id)}>${h.tabOpen ? "Go to tab" : "Open"}</${Button}>
                  <${Button} size="sm" onClick=${() => void markEntryApplied(id)}>Applied</${Button}>
                  <${Button} size="sm" onClick=${() => void forgetEntry(id)}>Retry</${Button}>
                </${JobLine}>`)
              : html`<p class="aa-dim">Nothing yet.</p>`}
          </div>
        </${Section}>

        <${Section} title="History">
          <div class="aa-card">
            ${done.length
              ? done.map(([id, h]) => html`<${JobLine} key=${id} item=${h}>
                  <${StatusBadge} status=${h.status} />
                  ${h.status !== "applied" ? html`<${Button} size="sm" onClick=${() => void forgetEntry(id)}>Retry</${Button}>` : null}
                </${JobLine}>`)
              : html`<p class="aa-dim">No finished applications yet.</p>`}
          </div>
        </${Section}>
      </div>
    </div>
  </main>`;
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
