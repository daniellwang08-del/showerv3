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
  if (pending.hadSessionAtStart) return false;
  const initial = new Set(pending.initialCookieNames || []);
  return authed.some((c) => !initial.has(c.name));
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

async function startJobSiteConnect(msg, sender) {
  const dashboardTabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
  const loginUrl = String(msg.loginUrl || "").trim();
  const domains = Array.isArray(msg.domains) ? msg.domains.map(String).filter(Boolean) : [];
  if (!loginUrl || !domains.length || dashboardTabId == null) {
    return { ok: false, error: "bad_request" };
  }

  const existing = await getPending();
  if (existing) {
    await abortPending(existing.requestId, "superseded");
  }

  watchCookies();

  const cookiesAtStart = await collectCookies(domains);
  const sessionAtStart = sessionNamedCookies(cookiesAtStart, msg.sessionCookieNames);
  const hadSessionAtStart = sessionAtStart.length > 0;

  let loginTab;
  try {
    loginTab = await chrome.tabs.create({ url: loginUrl, active: true });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err || "tab_open_failed") };
  }
  if (!loginTab || loginTab.id == null) {
    return { ok: false, error: "tab_open_failed" };
  }

  const pending = {
    requestId: msg.requestId || null,
    slug: String(msg.slug || ""),
    dashboardTabId,
    loginTabId: loginTab.id,
    domains,
    signedInUrlPatterns: Array.isArray(msg.signedInUrlPatterns) ? msg.signedInUrlPatterns : [],
    sessionCookieNames: Array.isArray(msg.sessionCookieNames) ? msg.sessionCookieNames : [],
    loginPathPatterns: Array.isArray(msg.loginPathPatterns) ? msg.loginPathPatterns : [],
    initialCookieNames: cookiesAtStart.map((c) => c.name),
    hadSessionAtStart,
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
    startJobSiteConnect(msg, sender)
      .then((resp) => sendResponse(resp))
      .catch((err) =>
        sendResponse({ ok: false, error: String((err && err.message) || err) }),
      );
    return true;
  }
  if (msg && msg.type === "ABORT_JOB_SITE_CONNECT") {
    abortPending(msg.requestId || null, msg.error || "cancelled")
      .then((resp) => sendResponse(resp))
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
