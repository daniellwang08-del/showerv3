/**
 * Job-site account connect, real tab redirect + navigation tracking.
 *
 * FLOW
 *   1. Dashboard "Connect" -> START_JOB_SITE_CONNECT.
 *   2. We open the board's signed-in landing page in a REAL tab
 *      (Jobright: https://jobright.ai/jobs/recommend). No iframe: boards send
 *      X-Frame-Options and their cookies would be third-party inside a frame.
 *   3. We track every navigation on that tab until loading settles.
 *   4. Where the tab ENDS UP is the login test:
 *        still on /jobs/recommend  -> already signed in
 *        bounced to /login|/       -> user must sign in; we keep watching
 *   5. Once signed in we capture cookies + localStorage + sessionStorage and
 *      hand them to the dashboard, which posts them to the backend.
 *
 * Every step console.logs under [nao:jobsite] in the service-worker
 * console and is mirrored to the dashboard page console via JOB_SITE_LOG.
 *
 * SERVICE-WORKER LIFETIME: signing in takes longer than the MV3 idle timeout,
 * so connect state lives in chrome.storage.session and all listeners are
 * registered at worker start, a restart mid-login resumes the same watch.
 */

const LOG_PREFIX = "[nao:jobsite]";
const WATCH_SCRIPT_ID = "nao-job-site-watch";

/**
 * Bumped whenever this module's message contract changes. Every ack carries it
 * so the dashboard can tell "connect failed" apart from "the service worker is
 * still running a previously-loaded build". An MV3 worker keeps executing the
 * module graph it was registered with, editing this file on disk does NOT
 * restart it, while content scripts are re-read on every page load. That mix
 * produces confusing, impossible-looking errors without this stamp.
 */
export const CONNECT_BUILD = "2026.10.02-nao-rebrand";
const STATE_KEY = "jobSiteConnectState";
const SETTLE_MS = 1800;
const MAX_STORAGE_BYTES = 96 * 1024;

/**
 * @typedef {{
 *   slug: string,
 *   startUrl: string,
 *   verifyUrl: string,
 *   cookieDomains: string[],
 *   signedInUrlPatterns: string[],
 *   loggedOutUrlPatterns: string[],
 *   sessionCookieNames: string[],
 *   dashboardTabId: number | null,
 *   siteTabId: number | null,
 *   siteWindowId: number | null,
 *   phase: string,
 *   lastUrl: string,
 *   captured: boolean,
 *   retriedVerifyUrl: boolean,
 * }} ConnectState
 */

/** @type {ConnectState | null} */
let active = null;
let hydrated = false;
let settleTimer = 0;

// ── logging ────────────────────────────────────────────────────────

function log(event, data) {
  if (data === undefined) console.log(`${LOG_PREFIX} ${event}`);
  else console.log(`${LOG_PREFIX} ${event}`, data);
  mirrorToDashboard(event, data, "log");
}

function warn(event, data) {
  if (data === undefined) console.warn(`${LOG_PREFIX} ${event}`);
  else console.warn(`${LOG_PREFIX} ${event}`, data);
  mirrorToDashboard(event, data, "warn");
}

function mirrorToDashboard(event, data, level) {
  if (!active || active.dashboardTabId == null) return;
  let detail = null;
  if (data !== undefined) {
    try {
      detail = JSON.parse(JSON.stringify(data));
    } catch {
      detail = String(data);
    }
  }
  notifyDashboard({
    type: "JOB_SITE_LOG",
    slug: active.slug,
    level: level || "log",
    event,
    detail,
    at: Date.now(),
  });
}

function notifyDashboard(payload) {
  if (!active || active.dashboardTabId == null) return;
  try {
    chrome.tabs.sendMessage(active.dashboardTabId, payload, () => void chrome.runtime.lastError);
  } catch {
    /* dashboard tab gone */
  }
}

// ── state persistence ──────────────────────────────────────────────

async function persist() {
  try {
    if (active) await chrome.storage.session.set({ [STATE_KEY]: active });
    else await chrome.storage.session.remove(STATE_KEY);
  } catch (err) {
    console.warn(`${LOG_PREFIX} state:persist_failed`, err);
  }
}

async function ensureActive() {
  if (active || hydrated) return active;
  hydrated = true;
  try {
    const data = await chrome.storage.session.get(STATE_KEY);
    active = (data && data[STATE_KEY]) || null;
    if (active) {
      console.log(`${LOG_PREFIX} state:restored`, {
        slug: active.slug,
        siteTabId: active.siteTabId,
        phase: active.phase,
        lastUrl: active.lastUrl,
      });
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} state:restore_failed`, err);
    active = null;
  }
  return active;
}

/** Run a handler only when a connect is in progress (hydrating if needed). */
function withActive(fn) {
  void (async () => {
    const state = await ensureActive();
    if (!state) return;
    try {
      await fn(state);
    } catch (err) {
      console.error(`${LOG_PREFIX} handler:failed`, err);
    }
  })();
}

function setPhase(phase, url, extra) {
  if (!active) return;
  active.phase = phase;
  const detail = { phase, url: url || active.lastUrl || "", ...(extra || {}) };
  log(`phase:${phase}`, detail);
  notifyDashboard({
    type: "JOB_SITE_CONNECT_STATUS",
    slug: active.slug,
    state: phase,
    url: detail.url,
    ...(extra || {}),
  });
  void persist();
}

// ── url / cookie helpers ───────────────────────────────────────────

function strList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v || "").trim()).filter(Boolean);
}

function normalizeDomain(domain) {
  return String(domain || "")
    .trim()
    .replace(/^\.+/, "")
    .toLowerCase();
}

function originPatterns(domains) {
  const out = [];
  for (const raw of domains) {
    const d = normalizeDomain(raw);
    if (!d) continue;
    out.push(`https://${d}/*`, `https://*.${d}/*`);
  }
  return [...new Set(out)];
}

function urlMatches(url, patterns) {
  const u = String(url || "").toLowerCase();
  if (!u) return false;
  return patterns.some((p) => u.includes(String(p).toLowerCase()));
}

function isTrackedUrl(url) {
  if (!active || !url || !/^https?:/i.test(url)) return false;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return active.cookieDomains.some((d) => {
    const domain = normalizeDomain(d);
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/** 'signed_in' | 'signed_out' | 'unknown' - purely from where the tab landed. */
function classifyUrl(url) {
  if (!active || !url) return "unknown";
  if (!isTrackedUrl(url)) return "unknown";
  if (urlMatches(url, active.loggedOutUrlPatterns)) return "signed_out";
  if (urlMatches(url, active.signedInUrlPatterns)) return "signed_in";
  return "unknown";
}

function cookieNameMatches(name, needles) {
  const n = String(name || "").toLowerCase();
  if (!n) return false;
  return needles.some((needle) => {
    const x = String(needle || "").toLowerCase();
    return x && (n === x || n.includes(x));
  });
}

function hasSessionCookies(cookies) {
  if (!active || !cookies.length) return false;
  if (!active.sessionCookieNames.length) return true;
  return cookies.some((c) => cookieNameMatches(c.name, active.sessionCookieNames));
}

function serializeCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain || "",
    path: c.path || "/",
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
    sameSite: c.sameSite || "",
    expirationDate: c.expirationDate,
  };
}

function cookieHeader(cookies) {
  const seen = new Set();
  const parts = [];
  for (const c of cookies) {
    if (!c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join("; ");
}

async function collectCookies() {
  if (!active) return [];
  const out = [];
  const seen = new Set();
  for (const raw of active.cookieDomains) {
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    let list = [];
    try {
      // A bare `domain` filter already covers sub-domains and host-only cookies.
      list = await chrome.cookies.getAll({ domain });
    } catch (err) {
      warn("cookies:read_failed", { domain, error: String((err && err.message) || err) });
      continue;
    }
    for (const c of list || []) {
      const key = `${c.domain}|${c.path}|${c.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(serializeCookie(c));
    }
    log("cookies:read", { domain, count: (list || []).length });
  }
  return out;
}

// ── capture ────────────────────────────────────────────────────────

function clampStorage(bucket) {
  const out = {};
  let bytes = 0;
  for (const [key, value] of Object.entries(bucket || {})) {
    const size = key.length + String(value == null ? "" : value).length;
    if (bytes + size > MAX_STORAGE_BYTES) continue;
    bytes += size;
    out[key] = value;
  }
  return out;
}

async function collectStorage() {
  const empty = { localStorage: {}, sessionStorage: {} };
  if (!active || active.siteTabId == null) return empty;
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: active.siteTabId },
      func: () => {
        const pack = (store) => {
          const o = {};
          try {
            for (let i = 0; i < store.length; i += 1) {
              const k = store.key(i);
              if (k) o[k] = store.getItem(k);
            }
          } catch (e) {
            /* storage blocked */
          }
          return o;
        };
        return {
          localStorage: pack(window.localStorage),
          sessionStorage: pack(window.sessionStorage),
          href: location.href,
        };
      },
    });
    const result = injected && injected[0] && injected[0].result;
    if (!result) return empty;
    const packed = {
      localStorage: clampStorage(result.localStorage),
      sessionStorage: clampStorage(result.sessionStorage),
    };
    log("storage:read", {
      url: result.href,
      localKeys: Object.keys(packed.localStorage).length,
      sessionKeys: Object.keys(packed.sessionStorage).length,
    });
    return packed;
  } catch (err) {
    warn("storage:read_failed", { error: String((err && err.message) || err) });
    return empty;
  }
}

async function captureSession(url, reason) {
  if (!active || active.captured) return false;
  log("capture:start", { url, reason });

  const cookies = await collectCookies();
  if (!cookies.length) {
    warn("capture:no_cookies", { url, reason });
    return false;
  }
  if (!hasSessionCookies(cookies)) {
    warn("capture:no_session_cookie", {
      url,
      reason,
      lookingFor: active.sessionCookieNames,
      found: cookies.map((c) => c.name),
    });
    if (classifyUrl(url) !== "signed_in") return false;
    log("capture:url_override", { url, note: "signed-in URL without a named session cookie" });
  }

  active.captured = true;
  await persist();
  setPhase("capturing", url, { reason });

  const storage = await collectStorage();
  const payload = {
    type: "JOB_SITE_SESSION",
    slug: active.slug,
    url: url || active.lastUrl || active.startUrl,
    reason,
    cookies,
    cookieHeader: cookieHeader(cookies),
    storage,
  };
  log("capture:send", {
    url: payload.url,
    reason,
    cookies: cookies.length,
    cookieNames: cookies.map((c) => c.name),
    localKeys: Object.keys(storage.localStorage).length,
    sessionKeys: Object.keys(storage.sessionStorage).length,
  });
  notifyDashboard(payload);
  return true;
}

/**
 * Decide from the settled URL. Runs after the tab reports "complete" plus a
 * settle delay, so client-side redirects (Jobright bounces /jobs/recommend to
 * its landing page when signed out) have already happened.
 */
async function evaluateSettled(url) {
  if (!active || active.captured) return;
  const verdict = classifyUrl(url);
  log("evaluate", {
    url,
    verdict,
    signedInPatterns: active.signedInUrlPatterns,
    loggedOutPatterns: active.loggedOutUrlPatterns,
  });

  if (verdict === "signed_in") {
    setPhase("signed_in", url);
    await captureSession(url, "signed_in_url");
    return;
  }

  if (verdict === "signed_out") {
    setPhase("signed_out", url);
    return;
  }

  // Landing page did not redirect anywhere conclusive (marketing home,
  // interstitial). If session cookies exist, open the protected page once,
  // it either renders (signed in) or bounces to login (signed out).
  const cookies = await collectCookies();
  if (hasSessionCookies(cookies) && !active.retriedVerifyUrl && active.verifyUrl) {
    active.retriedVerifyUrl = true;
    await persist();
    log("evaluate:cookie_fallback", {
      url,
      verifyUrl: active.verifyUrl,
      note: "session cookie present but landing URL was inconclusive",
    });
    setPhase("verifying", url);
    await gotoVerifyUrl("cookie_fallback");
    return;
  }
  setPhase("signed_out", url);
}

async function gotoVerifyUrl(reason) {
  if (!active || active.siteTabId == null) return;
  const target = active.verifyUrl || active.startUrl;
  log("navigate:verify_url", { url: target, reason });
  try {
    await chrome.tabs.update(active.siteTabId, { url: target });
  } catch (err) {
    warn("navigate:failed", { error: String((err && err.message) || err) });
  }
}

function scheduleSettle(url, source) {
  if (!active) return;
  if (settleTimer) clearTimeout(settleTimer);
  log("settle:scheduled", { url, source, delayMs: SETTLE_MS });
  settleTimer = setTimeout(() => {
    settleTimer = 0;
    withActive(async (state) => {
      const finalUrl = state.lastUrl || url;
      log("settle:fired", { url: finalUrl, source });
      await evaluateSettled(finalUrl);
    });
  }, SETTLE_MS);
}

// ── listeners (registered once per worker start) ───────────────────

function onTabUpdated(tabId, changeInfo, tab) {
  if (active && tabId !== active.siteTabId) return;
  withActive(async (state) => {
    if (tabId !== state.siteTabId) return;
    const url = (tab && tab.url) || changeInfo.url || state.lastUrl;
    if (changeInfo.url) {
      log("nav:url_changed", { url: changeInfo.url, from: state.lastUrl });
      state.lastUrl = changeInfo.url;
      await persist();
      if (!state.captured) setPhase("loading", changeInfo.url);
    }
    if (changeInfo.status === "loading") log("nav:loading", { url });
    if (changeInfo.status === "complete") {
      if (url) {
        state.lastUrl = url;
        await persist();
      }
      log("nav:complete", { url });
      scheduleSettle(url, "tabs.onUpdated");
    }
  });
}

function onTabRemoved(tabId) {
  if (active && tabId !== active.siteTabId) return;
  withActive(async (state) => {
    if (tabId !== state.siteTabId) return;
    log("tab:closed", { tabId, captured: state.captured });
    if (!state.captured) {
      notifyDashboard({
        type: "JOB_SITE_CONNECT_STATUS",
        slug: state.slug,
        state: "cancelled",
        url: state.lastUrl,
      });
    }
    state.siteTabId = null;
    await persist();
  });
}

function onNavCommitted(details) {
  if (!details || details.frameId !== 0) return;
  withActive(async (state) => {
    if (details.tabId !== state.siteTabId) return;
    log("nav:committed", { url: details.url, transition: details.transitionType });
    state.lastUrl = details.url;
    await persist();
  });
}

function onNavCompleted(details) {
  if (!details || details.frameId !== 0) return;
  withActive(async (state) => {
    if (details.tabId !== state.siteTabId) return;
    log("nav:dom_complete", { url: details.url });
    state.lastUrl = details.url;
    await persist();
    scheduleSettle(details.url, "webNavigation.onCompleted");
  });
}

function onHistoryStateUpdated(details) {
  if (!details || details.frameId !== 0) return;
  withActive(async (state) => {
    if (details.tabId !== state.siteTabId) return;
    log("nav:spa_route", { url: details.url, from: state.lastUrl });
    state.lastUrl = details.url;
    await persist();
    scheduleSettle(details.url, "webNavigation.onHistoryStateUpdated");
  });
}

function onCookieChanged(changeInfo) {
  if (!changeInfo || !changeInfo.cookie) return;
  withActive(async (state) => {
    if (state.captured) return;
    const domain = normalizeDomain(changeInfo.cookie.domain);
    const tracked = state.cookieDomains.some((d) => {
      const target = normalizeDomain(d);
      return domain === target || domain.endsWith(`.${target}`) || target.endsWith(`.${domain}`);
    });
    if (!tracked) return;
    if (!cookieNameMatches(changeInfo.cookie.name, state.sessionCookieNames)) return;
    log("cookies:session_cookie_event", {
      name: changeInfo.cookie.name,
      domain: changeInfo.cookie.domain,
      removed: Boolean(changeInfo.removed),
      cause: changeInfo.cause,
    });
    if (changeInfo.removed) return;
    // A session cookie just appeared => the login POST succeeded. The redirect
    // to the signed-in page follows; the settle pass does the capture.
    scheduleSettle(state.lastUrl, "cookies.onChanged");
  });
}

/** The board page reports its own URL / readyState (catches SPA re-renders). */
function onPageReport(msg, sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  withActive(async (state) => {
    if (tabId !== state.siteTabId) return;
    const url = String(msg.url || "");
    log("page:report", { url, readyState: msg.readyState, source: msg.source });
    if (url && url !== state.lastUrl) {
      log("nav:page_url_changed", { url, from: state.lastUrl });
      state.lastUrl = url;
      await persist();
    }
    if (msg.readyState === "complete" || msg.source === "url_poll") {
      scheduleSettle(url, `content:${msg.source || "load"}`);
    }
  });
}

function bindListeners() {
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  if (chrome.webNavigation) {
    chrome.webNavigation.onCommitted.addListener(onNavCommitted);
    chrome.webNavigation.onCompleted.addListener(onNavCompleted);
    chrome.webNavigation.onHistoryStateUpdated.addListener(onHistoryStateUpdated);
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(onHistoryStateUpdated);
  }
  if (chrome.cookies && chrome.cookies.onChanged) {
    chrome.cookies.onChanged.addListener(onCookieChanged);
  }
  console.log(`${LOG_PREFIX} listeners:bound`);
}

// ── dynamic content script ─────────────────────────────────────────

async function registerWatchScript(domains) {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;
  const matches = originPatterns(domains);
  if (!matches.length) return;
  await unregisterWatchScript();
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: WATCH_SCRIPT_ID,
        js: ["content/job-site-watch.js"],
        matches,
        allFrames: false,
        runAt: "document_start",
        persistAcrossSessions: false,
      },
    ]);
    log("watch_script:registered", { matches });
  } catch (err) {
    warn("watch_script:register_failed", { error: String((err && err.message) || err) });
  }
}

async function unregisterWatchScript() {
  if (!chrome.scripting || !chrome.scripting.unregisterContentScripts) return;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [WATCH_SCRIPT_ID] });
  } catch {
    /* not registered */
  }
}

// ── public API ─────────────────────────────────────────────────────

export async function startConnect(rawSession, sender) {
  const session = rawSession && typeof rawSession === "object" ? rawSession : {};
  const cookieDomains = strList(session.cookieDomains || session.cookie_domains).map(normalizeDomain);
  const startUrl = String(session.startUrl || session.start_url || "").trim();

  console.log(`${LOG_PREFIX} connect:requested`, {
    session,
    senderTab: sender && sender.tab && sender.tab.id,
  });

  if (!cookieDomains.length) throw new Error("Missing cookie domains for this job site.");
  if (!startUrl) throw new Error("Missing start URL for this job site.");

  await stopConnect({ keepTab: false, silent: true, focusDashboard: false });

  active = {
    slug: String(session.slug || ""),
    startUrl,
    verifyUrl: String(session.verifyUrl || session.verify_url || "").trim() || startUrl,
    cookieDomains,
    signedInUrlPatterns: strList(session.signedInUrlPatterns || session.signed_in_url_patterns),
    loggedOutUrlPatterns: strList(session.loggedOutUrlPatterns || session.logged_out_url_patterns),
    sessionCookieNames: strList(session.sessionCookieNames || session.session_cookie_names),
    dashboardTabId: sender && sender.tab && sender.tab.id != null ? sender.tab.id : null,
    siteTabId: null,
    siteWindowId: null,
    phase: "starting",
    lastUrl: "",
    captured: false,
    retriedVerifyUrl: false,
  };
  hydrated = true;
  await persist();

  log("connect:start", {
    slug: active.slug,
    startUrl: active.startUrl,
    verifyUrl: active.verifyUrl,
    cookieDomains: active.cookieDomains,
    signedInUrlPatterns: active.signedInUrlPatterns,
    loggedOutUrlPatterns: active.loggedOutUrlPatterns,
    sessionCookieNames: active.sessionCookieNames,
    dashboardTabId: active.dashboardTabId,
  });

  await registerWatchScript(cookieDomains);

  // Pre-flight: an existing session usually shows up as cookies before we even
  // navigate. Logged for diagnosis; where the tab lands still decides.
  const preCookies = await collectCookies();
  log("connect:preflight_cookies", {
    count: preCookies.length,
    names: preCookies.map((c) => c.name),
    hasSessionCookie: hasSessionCookies(preCookies),
  });

  const tab = await chrome.tabs.create({ url: active.startUrl, active: true });
  active.siteTabId = tab && tab.id != null ? tab.id : null;
  active.siteWindowId = tab && tab.windowId != null ? tab.windowId : null;
  active.lastUrl = active.startUrl;
  await persist();
  log("tab:opened", { tabId: active.siteTabId, url: active.startUrl });

  setPhase("navigating", active.startUrl);
  return { ok: true, build: CONNECT_BUILD, slug: active.slug, tabId: active.siteTabId };
}

export async function stopConnect({ keepTab = false, silent = false, focusDashboard = true } = {}) {
  const state = await ensureActive();
  if (!state) {
    if (!silent) console.log(`${LOG_PREFIX} stop:noop`);
    return { ok: true, build: CONNECT_BUILD };
  }
  if (!silent) {
    log("stop", {
      slug: state.slug,
      siteTabId: state.siteTabId,
      captured: state.captured,
      keepTab,
    });
  }
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = 0;
  }
  const { siteTabId, dashboardTabId } = state;
  active = null;
  await persist();
  await unregisterWatchScript();

  if (!keepTab && siteTabId != null) {
    try {
      await chrome.tabs.remove(siteTabId);
      console.log(`${LOG_PREFIX} tab:closed_by_stop`, { tabId: siteTabId });
    } catch {
      /* already closed */
    }
  }
  if (focusDashboard && dashboardTabId != null) {
    try {
      await chrome.tabs.update(dashboardTabId, { active: true });
    } catch {
      /* dashboard tab gone */
    }
  }
  return { ok: true, build: CONNECT_BUILD };
}

export async function captureNow() {
  const state = await ensureActive();
  if (!state) throw new Error("No job-site connect in progress.");
  log("capture:manual_requested", { url: state.lastUrl });
  state.captured = false;
  const url = state.lastUrl || state.startUrl;
  const ok = await captureSession(url, "manual");
  if (!ok) {
    state.captured = false;
    await persist();
    throw new Error("No signed-in session found yet. Finish signing in, then try again.");
  }
  return { ok: true, build: CONNECT_BUILD };
}

export async function focusSiteTab() {
  const state = await ensureActive();
  if (!state || state.siteTabId == null) throw new Error("No job-site tab open.");
  await chrome.tabs.update(state.siteTabId, { active: true });
  if (state.siteWindowId != null) {
    try {
      await chrome.windows.update(state.siteWindowId, { focused: true });
    } catch {
      /* window gone */
    }
  }
  log("tab:focused", { tabId: state.siteTabId });
  return { ok: true, build: CONNECT_BUILD };
}

export function attachMessageHandlers() {
  console.log(`${LOG_PREFIX} handlers:attached`, { build: CONNECT_BUILD });
  bindListeners();
  void ensureActive();

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return false;

    if (msg.type === "START_JOB_SITE_CONNECT") {
      (async () => {
        try {
          sendResponse(await startConnect(msg.session, sender));
        } catch (err) {
          const error = String((err && err.message) || err);
          console.error(`${LOG_PREFIX} connect:failed`, error);
          sendResponse({ ok: false, build: CONNECT_BUILD, error });
        }
      })();
      return true;
    }

    if (msg.type === "STOP_JOB_SITE_CONNECT") {
      (async () => {
        try {
          sendResponse(await stopConnect({ keepTab: Boolean(msg.keepTab) }));
        } catch (err) {
          sendResponse({ ok: false, build: CONNECT_BUILD, error: String((err && err.message) || err) });
        }
      })();
      return true;
    }

    if (msg.type === "CAPTURE_JOB_SITE_NOW") {
      (async () => {
        try {
          sendResponse(await captureNow());
        } catch (err) {
          const error = String((err && err.message) || err);
          console.warn(`${LOG_PREFIX} capture:manual_failed`, error);
          sendResponse({ ok: false, build: CONNECT_BUILD, error });
        }
      })();
      return true;
    }

    if (msg.type === "FOCUS_JOB_SITE_TAB") {
      (async () => {
        try {
          sendResponse(await focusSiteTab());
        } catch (err) {
          sendResponse({ ok: false, build: CONNECT_BUILD, error: String((err && err.message) || err) });
        }
      })();
      return true;
    }

    if (msg.type === "JOB_SITE_PAGE_REPORT") {
      onPageReport(msg, sender);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
}
