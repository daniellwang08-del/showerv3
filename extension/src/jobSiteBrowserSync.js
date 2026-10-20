// Browser-synced job boards. Sites that block servers can be read in the
// user's own browser: the backend hands the extension due "tasks", a collector
// reads the listings in a background window, and the jobs are posted back.
// No board currently ships a collector, so due tasks report that the extension
// needs an update. Functions passed to chrome.scripting.executeScript run
// inside the board's page and must stay self-contained.

import { apiFetch } from "./api.js";
import { CONNECT_BUILD } from "./jobSiteConnect.js";
import { getToken } from "./storage.js";

const LOG_PREFIX = "[nao:jobsite:browser]";
const ALARM = "nao-job-site-browser-sync";
const PERIOD_MINUTES = 30;
const LOCK_KEY = "jobSiteBrowserSyncLock";
const LOCK_TTL_MS = 12 * 60 * 1000;

// ── tab plumbing ─────────────────────────────────────────────────────────────

async function openWorkTab(url) {
  try {
    const win = await chrome.windows.create({ url, focused: false, state: "minimized" });
    const tab = win.tabs && win.tabs[0];
    if (tab && tab.id != null) return { tabId: tab.id, windowId: win.id };
  } catch (err) {
    console.warn(LOG_PREFIX, "minimized window failed, using a background tab", err);
  }
  const tab = await chrome.tabs.create({ url, active: false });
  return { tabId: tab.id, windowId: null };
}

async function closeWorkTab(work) {
  if (!work) return;
  try {
    if (work.windowId != null) await chrome.windows.remove(work.windowId);
    else if (work.tabId != null) await chrome.tabs.remove(work.tabId);
  } catch {
    /* already closed by the user */
  }
}

// ── collectors ───────────────────────────────────────────────────────────────

/** collector name -> async (task, work) => { jobs, error?, blocked? } */
const COLLECTORS = {};

async function runTask(task) {
  const collect = COLLECTORS[task.collector];
  let outcome;
  let work = null;
  if (!collect || !task.urls || !task.urls.length) {
    outcome = { jobs: [], error: "Update the NAO extension to sync this site." };
  } else {
    try {
      work = await openWorkTab(task.urls[0]);
      outcome = await collect(task, work);
    } catch (err) {
      outcome = { jobs: [], error: String((err && err.message) || err).slice(0, 400) };
    } finally {
      await closeWorkTab(work);
    }
  }
  const jobs = (outcome.jobs || []).filter((j) => j && j.url);
  console.log(LOG_PREFIX, "task:done", { slug: task.slug, jobs: jobs.length, blocked: !!outcome.blocked, error: outcome.error || null });
  await apiFetch(`/job-sites/${encodeURIComponent(task.slug)}/browser-results`, {
    method: "POST",
    body: {
      jobs,
      error: jobs.length ? null : outcome.error || null,
      blocked: !!outcome.blocked && !jobs.length,
    },
    timeoutMs: 120_000,
  });
}

async function acquireLock() {
  const now = Date.now();
  const data = await chrome.storage.session.get(LOCK_KEY);
  const held = data && data[LOCK_KEY];
  if (held && now - Number(held) < LOCK_TTL_MS) return false;
  await chrome.storage.session.set({ [LOCK_KEY]: now });
  return true;
}

async function releaseLock() {
  await chrome.storage.session.remove(LOCK_KEY).catch(() => {});
}

/** Fetch due browser-sync tasks from the backend and run them one by one. */
export async function runBrowserSync(reason = "alarm") {
  if (!(await getToken())) return { ok: false, error: "Sign in to the NAO extension first." };
  if (!(await acquireLock())) return { ok: true, running: true };
  try {
    const data = await apiFetch("/job-sites/browser-tasks", { timeoutMs: 30_000 });
    const tasks = (data && data.tasks) || [];
    console.log(LOG_PREFIX, "sync:start", { reason, tasks: tasks.map((t) => t.slug) });
    for (const task of tasks) {
      try {
        await runTask(task);
      } catch (err) {
        console.warn(LOG_PREFIX, "task failed", task.slug, err);
      }
    }
    return { ok: true, tasks: tasks.length };
  } catch (err) {
    console.warn(LOG_PREFIX, "sync failed", err);
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    await releaseLock();
  }
}

export function attachBrowserSync() {
  chrome.alarms.get(ALARM).then((existing) => {
    if (!existing) chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: PERIOD_MINUTES });
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void runBrowserSync("alarm");
  });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "RUN_JOB_SITE_BROWSER_SYNC") return false;
    (async () => {
      if (!(await getToken())) {
        sendResponse({ ok: false, build: CONNECT_BUILD, error: "Sign in to the NAO extension first." });
        return;
      }
      sendResponse({ ok: true, build: CONNECT_BUILD, started: true });
      void runBrowserSync("dashboard");
    })();
    return true;
  });
}
