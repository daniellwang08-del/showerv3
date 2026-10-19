// Browser-synced job boards (Glassdoor, Remote.co). These sites block servers,
// so the backend hands the extension due "tasks" and the extension reads the
// listings in a background window with the user's own browser, then posts the
// jobs back. Functions passed to chrome.scripting.executeScript run inside the
// board's page and must stay self-contained.

import { apiFetch } from "./api.js";
import { CONNECT_BUILD } from "./jobSiteConnect.js";
import { getToken } from "./storage.js";

const LOG_PREFIX = "[nao:jobsite:browser]";
const ALARM = "nao-job-site-browser-sync";
const PERIOD_MINUTES = 30;
const PAGE_LOAD_TIMEOUT_MS = 30_000;
const LOCK_KEY = "jobSiteBrowserSyncLock";
const LOCK_TTL_MS = 12 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

// ── page-side readers (self-contained) ───────────────────────────────────────

function pageIsBlocked() {
  const title = String(document.title || "").toLowerCase();
  const body = String((document.body && document.body.innerText) || "").slice(0, 2000).toLowerCase();
  return (
    title.startsWith("security") ||
    title.includes("access denied") ||
    title.includes("just a moment") ||
    body.includes("help us protect glassdoor") ||
    body.includes("verify you are human")
  );
}

function readGlassdoorSearch() {
  const one = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const cards = [...document.querySelectorAll("li[data-jobid]")].map((li) => {
    const link = li.querySelector("a[data-test=job-title]") || li.querySelector("a[data-test=job-link]");
    const company = li.querySelector("[class*=EmployerProfile_compactEmployerName]");
    return {
      id: String(li.getAttribute("data-jobid") || ""),
      title: one(link && link.textContent),
      company: one(company && company.textContent),
      location: one((li.querySelector("[data-test=emp-location]") || {}).textContent),
      href: link && link.href ? link.href : "",
    };
  });
  return {
    origin: location.origin,
    path: location.pathname,
    search: location.search,
    cards: cards.filter((c) => c.id && c.title),
  };
}

async function readGlassdoorJob(jobId, waitMs) {
  const deadline = Date.now() + waitMs;
  const tidy = (s) =>
    String(s || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  for (;;) {
    const title = document.getElementById("jd-job-title-" + jobId);
    const desc = document.querySelector("[class*=JobDetails_jobDescription]");
    if (title && desc && desc.innerText.trim().length > 50) {
      return { ok: true, description: tidy(desc.innerText).slice(0, 60000) };
    }
    if (Date.now() > deadline) return { ok: false };
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function listRemoteCo(urls) {
  const listed = new Map();
  for (const url of urls) {
    const res = await fetch(url, { credentials: "include" });
    if (res.status === 403 || res.status === 429) return { blocked: true, jobs: [] };
    if (!res.ok) continue;
    const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(await res.text());
    const props = m ? (JSON.parse(m[1]).props || {}).pageProps || {} : {};
    const jobs = ((props.jobCardData || {}).jobs || {}).results || [];
    for (const job of jobs) {
      if (job && job.isFreeJob && job.slug && !listed.has(job.id)) {
        listed.set(job.id, {
          slug: job.slug,
          title: job.title || "",
          company: (job.company && job.company.name) || "",
          locations: job.jobLocations || [],
          remote: (job.remoteOptions || [])[0] || "",
        });
      }
    }
  }
  return { blocked: false, jobs: [...listed.values()] };
}

async function readRemoteCoJob(job) {
  const tidy = (s) =>
    String(s || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  const htmlToText = (html) => {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    doc.querySelectorAll("li").forEach((li) => li.prepend("- "));
    doc.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    doc.querySelectorAll("p, div, li, ul, ol, h1, h2, h3, h4, h5, h6, section, tr").forEach((el) => el.append("\n"));
    return tidy(doc.body ? doc.body.textContent : "");
  };
  const listing = location.origin + "/job-details/" + job.slug;
  const res = await fetch("/job-details/" + encodeURIComponent(job.slug), { credentials: "include" });
  if (res.status === 403 || res.status === 429) return { blocked: true };
  if (!res.ok) return { job: null };
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(await res.text());
  const details = m ? ((JSON.parse(m[1]).props || {}).pageProps || {}).jobDetails : null;
  if (!details) return { job: null };
  const where = (details.jobLocations || job.locations || []).filter(Boolean).join("; ");
  const mode = (details.remoteOptions || [])[0] || job.remote;
  const apply = String(details.applyURL || details.applyUrl || "").trim();
  return {
    job: {
      url: /^https?:\/\//i.test(apply) ? apply : listing,
      source_url: listing,
      title: String(details.title || job.title || "").trim(),
      company: String((details.company && details.company.name) || job.company || "").trim(),
      location: [where, mode].filter(Boolean).join(" | "),
      description: htmlToText(details.description || details.jobSummary || "").slice(0, 60000),
    },
  };
}

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

function waitForComplete(tabId, { alreadyLoaded = true, timeoutMs = PAGE_LOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      fn();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish(resolve);
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(() => reject(new Error("The sync tab was closed.")));
    };
    const timer = setTimeout(() => finish(() => reject(new Error("The page took too long to load."))), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    if (!alreadyLoaded) return;
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab && tab.status === "complete" && tab.url && tab.url !== "about:blank") finish(resolve);
      })
      .catch(() => finish(() => reject(new Error("The sync tab was closed."))));
  });
}

async function navigate(tabId, url) {
  const loaded = waitForComplete(tabId, { alreadyLoaded: false });
  await chrome.tabs.update(tabId, { url });
  await loaded;
}

async function run(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res ? res.result : undefined;
}

// ── collectors ───────────────────────────────────────────────────────────────

export function glassdoorJobUrl(base, startUrl, jobId) {
  const params = new URLSearchParams(base.search);
  try {
    for (const [k, v] of new URL(startUrl).searchParams) {
      if (k !== "sc.keyword" && !params.has(k)) params.set(k, v);
    }
  } catch {
    /* start url is validated server-side */
  }
  params.delete("sc.keyword");
  params.set("jl", jobId);
  return `${base.origin}${base.path}?${params.toString()}`;
}

async function collectGlassdoor(task, work) {
  const startUrl = task.urls[0];
  await waitForComplete(work.tabId);
  if (await run(work.tabId, pageIsBlocked)) return { blocked: true, jobs: [] };
  const search = await run(work.tabId, readGlassdoorSearch);
  if (!search || !search.cards.length) {
    return { jobs: [], error: "Glassdoor showed no jobs for this search." };
  }
  const jobs = [];
  for (const card of search.cards.slice(0, task.max_jobs)) {
    await sleep(jitter(1200, 2600));
    await navigate(work.tabId, glassdoorJobUrl(search, startUrl, card.id));
    if (await run(work.tabId, pageIsBlocked)) return { blocked: jobs.length === 0, jobs };
    const detail = await run(work.tabId, readGlassdoorJob, [card.id, 10_000]);
    const listing = card.href || glassdoorJobUrl(search, startUrl, card.id);
    jobs.push({
      url: listing,
      source_url: listing,
      title: card.title,
      company: card.company,
      location: card.location,
      description: detail && detail.ok ? detail.description : "",
    });
  }
  return { jobs };
}

async function collectRemoteCo(task, work) {
  await waitForComplete(work.tabId);
  if (await run(work.tabId, pageIsBlocked)) return { blocked: true, jobs: [] };
  const listed = await run(work.tabId, listRemoteCo, [task.urls]);
  if (!listed) return { jobs: [], error: "Could not read Remote.co." };
  if (listed.blocked) return { blocked: true, jobs: [] };
  if (!listed.jobs.length) {
    return { jobs: [], error: "Remote.co showed no free listings in these categories." };
  }
  const jobs = [];
  for (const item of listed.jobs.slice(0, task.max_jobs)) {
    const res = await run(work.tabId, readRemoteCoJob, [item]);
    if (res && res.blocked) return { blocked: jobs.length === 0, jobs };
    if (res && res.job) jobs.push(res.job);
    await sleep(jitter(400, 1000));
  }
  return { jobs };
}

const COLLECTORS = { glassdoor: collectGlassdoor, remoteco: collectRemoteCo };

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
