// Auto-connect a session-based job site (Jobright, RemoteRocketship, …).
//
// Flow:
//   dashboard click → content-script permissions.request (user gesture)
//   → START_JOB_SITE_CONNECT → open a dedicated login tab
//   → watch URL + cookies until the user is signed in
//   → POST cookies back to the dashboard tab → close the login tab.
//
// Pending state lives in chrome.storage.session so an MV3 worker sleep
// mid-login can resume from tabs.onUpdated / cookies.onChanged / webNavigation.

const STORAGE_KEY = "pendingJobSiteConnect";
// A connect request that is parked until the user grants cookie access in the
// side panel. Kept separate from STORAGE_KEY because no login tab exists yet,
// so none of the tab/cookie watchers below should act on it.
const GRANT_KEY = "pendingJobSiteGrant";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_NAMES = ["jwt", "token", "session", "auth", "sid", "SESSION_ID"];

let finishing = false;

async function getPending() {
  try {
    const data = await chrome.storage.session.get(STORAGE_KEY);
    return data[STORAGE_KEY] || null;
  } catch {
    return null;
  }
}

async function setPending(state) {
  try {
    if (!state) {
      await chrome.storage.session.remove(STORAGE_KEY);
      return;
    }
    await chrome.storage.session.set({ [STORAGE_KEY]: state });
  } catch (err) {
    console.warn("jobSiteConnect persist failed", err);
  }
}

async function getPendingGrant() {
  try {
    const data = await chrome.storage.session.get(GRANT_KEY);
    return data[GRANT_KEY] || null;
  } catch {
    return null;
  }
}

// The grant prompt lives in the side panel, which the user can easily miss or
// close. Mark the toolbar icon while a request is parked so the pending action
// is visible from anywhere, not only in the tab that started it.
function setGrantBadge(pending) {
  try {
    chrome.action.setBadgeText({ text: pending ? "!" : "" });
    if (pending) {
      chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
      chrome.action.setTitle({
        title: "Atomspace — allow cookie access to finish connecting",
      });
    } else {
      chrome.action.setTitle({ title: "Open Atomspace Assistant" });
    }
  } catch (err) {
    console.warn("grant badge failed", err);
  }
}

async function setPendingGrant(state) {
  try {
    if (!state) {
      await chrome.storage.session.remove(GRANT_KEY);
      setGrantBadge(false);
      return;
    }
    await chrome.storage.session.set({ [GRANT_KEY]: state });
    setGrantBadge(true);
  } catch (err) {
    console.warn("jobSiteConnect grant persist failed", err);
  }
}

// Cookie access cannot be requested from the dashboard's content script, so the
// panel does the asking. Checking is fine anywhere, and when access is already
// granted we skip the prompt entirely and go straight to the login tab.
async function hasCookieAccess(origins) {
  try {
    return await chrome.permissions.contains({
      permissions: ["cookies"],
      origins: Array.isArray(origins) ? origins.filter(Boolean) : [],
    });
  } catch (err) {
    console.warn("permissions.contains failed", err);
    return false;
  }
}

// Resolves to whether the panel actually opened, so a parked grant can fall
// back to its own window rather than waiting on a prompt nobody can see.
let sidePanelOpened = Promise.resolve(false);

// Must be called synchronously from the onMessage listener: the bridge relays
// the dashboard click, and Chrome drops the gesture at the first await.
function openSidePanel(sender) {
  const windowId = sender && sender.tab && sender.tab.windowId != null ? sender.tab.windowId : null;
  if (windowId == null) {
    sidePanelOpened = Promise.resolve(false);
    return;
  }
  try {
    sidePanelOpened = chrome.sidePanel.open({ windowId }).then(
      () => true,
      (err) => {
        console.warn("sidePanel.open (job site connect) failed", err);
        return false;
      },
    );
  } catch (err) {
    console.warn("sidePanel.open (job site connect) threw", err);
    sidePanelOpened = Promise.resolve(false);
  }
}

// Without a visible prompt the request just sits there and the dashboard waits
// on a click that can never happen, so open a small window instead.
async function surfaceGrantPrompt() {
  const opened = await sidePanelOpened.catch(() => false);
  if (opened) return;
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL("permission.html?standalone=1"),
      type: "popup",
      width: 420,
      height: 340,
    });
  } catch (err) {
    console.warn("permission window failed", err);
  }
}

function serializeCookies(cookies) {
  const seen = new Set();
  const out = [];
  for (const c of cookies || []) {
    const name = String(c.name || "").trim();
    const value = c.value == null ? "" : String(c.value);
    if (!name || !value) continue;
    const domain = String(c.domain || "");
    const path = String(c.path || "/") || "/";
    const key = `${name}|${domain}|${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sameSite =
      c.sameSite === "no_restriction" || c.sameSite === "None"
        ? "None"
        : c.sameSite === "strict" || c.sameSite === "Strict"
          ? "Strict"
          : "Lax";
    out.push({
      name,
      value,
      domain,
      path,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite,
      expirationDate: c.session ? -1 : c.expirationDate || -1,
    });
  }
  return out;
}

async function collectCookies(domains) {
  const all = [];
  for (const domain of domains || []) {
    try {
      const part = await chrome.cookies.getAll({ domain: String(domain) });
      all.push(...part);
    } catch (err) {
      console.warn("cookies.getAll failed", domain, err);
    }
  }
  return serializeCookies(all);
}

function hostMatches(url, domains) {
  if (!url || !domains || !domains.length) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((d) => {
      const needle = String(d || "")
        .toLowerCase()
        .replace(/^\./, "");
      return needle && (host === needle || host.endsWith("." + needle));
    });
  } catch {
    return false;
  }
}

function urlMatchesAny(url, patterns) {
  if (!url || !patterns || !patterns.length) return false;
  const lower = String(url).toLowerCase();
  return patterns.some((p) => p && lower.includes(String(p).toLowerCase()));
}

function sessionNamedCookies(cookies, names) {
  const keys = (names && names.length ? names : DEFAULT_SESSION_NAMES).map((n) =>
    String(n).toLowerCase(),
  );
  return (cookies || []).filter((c) =>
    keys.some((k) => String(c.name || "").toLowerCase().includes(k)),
  );
}

function cookieKey(cookie) {
  return String(cookie.name || "") + "=" + String(cookie.value == null ? "" : cookie.value);
}

function isSignedIn(pending, tab, cookies) {
  const url = (tab && tab.url) || "";
  if (!url || /^(chrome|chrome-extension|about|edge|devtools):/i.test(url)) return false;
  if (!hostMatches(url, pending.domains)) return false;
  if (urlMatchesAny(url, pending.loginPathPatterns)) return false;
  const authed = sessionNamedCookies(cookies, pending.sessionCookieNames);
  if (!authed.length) return false;
  const urlSignedIn = urlMatchesAny(url, pending.signedInUrlPatterns);
  const complete = !tab || tab.status === "complete";
  if (!complete) return false;
  if (urlSignedIn) return true;
  // Compare name AND value. Signing in normally refreshes a cookie that is
  // already present (jwt, SESSION_ID) rather than introducing a new name, so
  // a name-only diff never fired for anyone who arrived carrying a stale
  // session -- the connect just sat there until the ten-minute timeout.
  const initial = new Set(pending.initialCookieSignature || []);
  return authed.some((c) => !initial.has(cookieKey(c)));
}

async function focusDashboard(tabId) {
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab && tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
  } catch {
    /* dashboard tab gone */
  }
}

async function notifyDashboard(pending, payload) {
  const message = {
    type: "JOB_SITE_CONNECT_RESULT",
    requestId: pending.requestId,
    ok: Boolean(payload.ok),
    cookies: payload.cookies || [],
    error: payload.error || null,
    preexisting: Boolean(payload.preexisting),
  };
  try {
    await chrome.tabs.sendMessage(pending.dashboardTabId, message);
    return;
  } catch {
    /* bridge may have been dropped; fall through */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: pending.dashboardTabId },
      func: (msg) => {
        try {
          window.postMessage(
            Object.assign({ source: "atomspace-extension" }, msg),
            "*",
          );
        } catch {
          /* ignore */
        }
      },
      args: [
        {
          type: "CONNECT_JOB_SITE_SESSION_RESULT",
          requestId: message.requestId,
          ok: message.ok,
          cookies: message.cookies,
          error: message.error,
          preexisting: message.preexisting,
        },
      ],
    });
  } catch (err) {
    console.warn("notify dashboard failed", err);
  }
}

async function finish(pending, payload, { closeTab }) {
  const current = await getPending();
  if (!current || current.requestId !== pending.requestId) {
    finishing = false;
    return;
  }
  await setPending(null);
  finishing = false;
  if (closeTab && pending.loginTabId != null) {
    try {
      await chrome.tabs.remove(pending.loginTabId);
    } catch {
      /* already closed */
    }
  }
  await notifyDashboard(pending, payload);
  await focusDashboard(pending.dashboardTabId);
}

async function maybeFinish() {
  if (finishing) return;
  finishing = true;
  try {
    const pending = await getPending();
    if (!pending) {
      finishing = false;
      return;
    }
    if (Date.now() - Number(pending.startedAt || 0) > LOGIN_TIMEOUT_MS) {
      await finish(pending, { ok: false, error: "timed_out" }, { closeTab: true });
      return;
    }
    let tab = null;
    try {
      tab = await chrome.tabs.get(pending.loginTabId);
    } catch {
      await finish(pending, { ok: false, error: "tab_closed" }, { closeTab: false });
      return;
    }
    const cookies = await collectCookies(pending.domains);
    if (!isSignedIn(pending, tab, cookies)) {
      // A loaded page, on the site, off any login path, and yet not a single
      // readable cookie: that is missing cookie access, not a user who has not
      // signed in. Waiting cannot fix it, so fail with a reason instead of
      // sitting on "waiting for sign-in" until the ten-minute timeout.
      const url = (tab && tab.url) || "";
      const settled = Date.now() - Number(pending.startedAt || 0) > 8000;
      const complete = !tab || tab.status === "complete";
      if (
        settled &&
        complete &&
        !cookies.length &&
        hostMatches(url, pending.domains) &&
        !urlMatchesAny(url, pending.loginPathPatterns)
      ) {
        await finish(pending, { ok: false, error: "cookies_unreadable" }, { closeTab: false });
        return;
      }
      finishing = false;
      return;
    }
    if (!cookies.length) {
      await finish(pending, { ok: false, error: "no_cookies" }, { closeTab: false });
      return;
    }
    await finish(pending, { ok: true, cookies, error: null }, { closeTab: true });
  } catch (err) {
    finishing = false;
    console.warn("jobSiteConnect maybeFinish failed", err);
  }
}

async function abortPending(requestId, error) {
  const pending = await getPending();
  if (!pending) return { ok: true, aborted: false };
  if (requestId && pending.requestId !== requestId) return { ok: true, aborted: false };
  finishing = true;
  await finish(pending, { ok: false, error: error || "cancelled" }, { closeTab: true });
  return { ok: true, aborted: true };
}

async function abortPendingGrant(requestId, error) {
  const grant = await getPendingGrant();
  if (!grant) return { ok: true, aborted: false };
  if (requestId && grant.requestId !== requestId) return { ok: true, aborted: false };
  await setPendingGrant(null);
  await notifyDashboard(grant, { ok: false, error: error || "cancelled" });
  return { ok: true, aborted: true };
}

async function startJobSiteConnect(msg, sender) {
  const dashboardTabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
  const loginUrl = String(msg.loginUrl || "").trim();
  const domains = Array.isArray(msg.domains) ? msg.domains.map(String).filter(Boolean) : [];
  if (!loginUrl || !domains.length || dashboardTabId == null) {
    return { ok: false, error: "bad_request" };
  }

  const request = {
    requestId: msg.requestId || null,
    slug: String(msg.slug || ""),
    name: String(msg.name || msg.slug || "this site"),
    dashboardTabId,
    loginUrl,
    domains,
    // Set by the dashboard when a pre-existing session was rejected by the
    // backend, so this attempt must go through the login tab.
    forceLogin: Boolean(msg.forceLogin),
    origins: Array.isArray(msg.origins) ? msg.origins.map(String).filter(Boolean) : [],
    signedInUrlPatterns: Array.isArray(msg.signedInUrlPatterns) ? msg.signedInUrlPatterns : [],
    sessionCookieNames: Array.isArray(msg.sessionCookieNames) ? msg.sessionCookieNames : [],
    loginPathPatterns: Array.isArray(msg.loginPathPatterns) ? msg.loginPathPatterns : [],
  };

  const existing = await getPending();
  if (existing) {
    await abortPending(existing.requestId, "superseded");
  }
  const staleGrant = await getPendingGrant();
  if (staleGrant) {
    await abortPendingGrant(staleGrant.requestId, "superseded");
  }

  // Park the request until the side panel can ask. Opening the login tab first
  // would be pointless: without cookie access we could never read the session
  // the user creates there.
  if (!(await hasCookieAccess(request.origins))) {
    await setPendingGrant(request);
    await surfaceGrantPrompt();
    return { ok: true, started: true, awaitingPermission: true };
  }

  return await beginLogin(request);
}

async function resumeJobSiteConnect(requestId) {
  const grant = await getPendingGrant();
  if (!grant) return { ok: false, error: "no_pending_request" };
  if (requestId && grant.requestId !== requestId) return { ok: false, error: "stale_request" };
  await setPendingGrant(null);
  const result = await beginLogin(grant);
  if (!result.ok) {
    await notifyDashboard(grant, { ok: false, error: result.error || "tab_open_failed" });
  }
  return result;
}

async function beginLogin(request) {
  watchCookies();

  const cookiesAtStart = await collectCookies(request.domains);
  const sessionAtStart = sessionNamedCookies(cookiesAtStart, request.sessionCookieNames);

  // The user is often already signed in on the site. Don't send them through a
  // login they don't need, and don't try to infer the state from the landing
  // URL -- that only works when the site happens to redirect somewhere the
  // plugin lists in signed_in_url_patterns. Hand over the cookies we already
  // have instead: the dashboard's /connect performs a real authenticated fetch
  // (verify_and_fetch), which is the only trustworthy signed-in check we have.
  // If the session turns out to be stale it comes back with forceLogin set and
  // we open the tab below.
  if (sessionAtStart.length && !request.forceLogin) {
    await notifyDashboard(request, {
      ok: true,
      cookies: cookiesAtStart,
      preexisting: true,
    });
    return { ok: true, started: true, preexisting: true };
  }

  let loginTab;
  try {
    loginTab = await chrome.tabs.create({ url: request.loginUrl, active: true });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err || "tab_open_failed") };
  }
  if (!loginTab || loginTab.id == null) {
    return { ok: false, error: "tab_open_failed" };
  }

  const pending = {
    requestId: request.requestId,
    slug: request.slug,
    dashboardTabId: request.dashboardTabId,
    loginTabId: loginTab.id,
    domains: request.domains,
    signedInUrlPatterns: request.signedInUrlPatterns,
    sessionCookieNames: request.sessionCookieNames,
    loginPathPatterns: request.loginPathPatterns,
    initialCookieSignature: cookiesAtStart.map(cookieKey),
    startedAt: Date.now(),
  };
  await setPending(pending);
  finishing = false;
  setTimeout(() => {
    void maybeFinish();
  }, 800);
  return { ok: true, started: true, loginTabId: loginTab.id };
}

function watchCookies() {
  if (watchCookies.bound) return;
  if (!chrome.cookies || !chrome.cookies.onChanged) return;
  try {
    chrome.cookies.onChanged.addListener(() => {
      void maybeFinish();
    });
    watchCookies.bound = true;
  } catch {
    /* cookies permission not granted yet */
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "START_JOB_SITE_CONNECT") {
    // FIRST, synchronously, before any await. The bridge relays this from
    // inside the dashboard click, so the user gesture is still live right here
    // and this is the only moment we can surface the panel where the cookie
    // grant is possible. Everything after this point is async and gesture-free.
    openSidePanel(sender);
    startJobSiteConnect(msg, sender)
      .then((resp) => sendResponse(resp))
      .catch((err) =>
        sendResponse({ ok: false, error: String((err && err.message) || err) }),
      );
    return true;
  }
  if (msg && msg.type === "RESUME_JOB_SITE_CONNECT") {
    resumeJobSiteConnect(msg.requestId || null)
      .then((resp) => sendResponse(resp))
      .catch((err) =>
        sendResponse({ ok: false, error: String((err && err.message) || err) }),
      );
    return true;
  }
  if (msg && msg.type === "ABORT_JOB_SITE_CONNECT") {
    const requestId = msg.requestId || null;
    const error = msg.error || "cancelled";
    // The request may be parked awaiting the grant or already in the login tab.
    Promise.all([abortPendingGrant(requestId, error), abortPending(requestId, error)])
      .then(([grant, pending]) =>
        sendResponse({ ok: true, aborted: grant.aborted || pending.aborted }),
      )
      .catch((err) =>
        sendResponse({ ok: false, error: String((err && err.message) || err) }),
      );
    return true;
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, _tab) => {
  void (async () => {
    const pending = await getPending();
    if (!pending || pending.loginTabId !== tabId) return;
    await maybeFinish();
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const pending = await getPending();
    if (!pending || pending.loginTabId !== tabId) return;
    finishing = true;
    await finish(pending, { ok: false, error: "tab_closed" }, { closeTab: false });
  })();
});

if (chrome.webNavigation && chrome.webNavigation.onCompleted) {
  chrome.webNavigation.onCompleted.addListener((details) => {
    if (!details || details.frameId !== 0) return;
    void (async () => {
      const pending = await getPending();
      if (!pending || pending.loginTabId !== details.tabId) return;
      await maybeFinish();
    })();
  });
}

watchCookies();
void maybeFinish();
// Session storage is cleared on browser restart, so re-derive the badge rather
// than leaving a stale "!" from a previous run.
void getPendingGrant().then((grant) => setGrantBadge(Boolean(grant)));
