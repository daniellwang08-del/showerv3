// Dashboard origins: production (nao.it.com), localhost, and private LAN.
// Chrome match patterns ignore ports, so LAN inject covers any Vite port (e.g. :5173).

import { getBackendUrl, normalizeBackendUrl, setBackendUrl, setCurrentUser, setToken } from "./src/storage.js";
import { isDashboardUrl } from "./src/backendOrigin.js";
import { attachMessageHandlers as attachJobSiteConnectHandlers } from "./src/jobSiteConnect.js";
import * as api from "./src/api.js";

const BRIDGE_FILE = "content/webapp-bridge.js";

/**
 * Hosts already covered by manifest content_scripts. Programmatic inject is
 * only needed for (a) tabs open before install and (b) LAN dashboard hosts not
 * listed in the manifest. Re-injecting into a live document without an
 * idempotent bridge stacks APPLY listeners → duplicate job tabs.
 */
function isManifestContentScriptHost(hostname) {
  const h = (hostname || "").toLowerCase();
  return (
    h === "nao.it.com" ||
    h === "www.nao.it.com" ||
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "[::1]"
  );
}

async function injectBridge(tabId, { force = false } = {}) {
  if (tabId == null) return;
  try {
    if (!force) {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.url) {
        try {
          const host = new URL(tab.url).hostname;
          // Already-open tabs at install still need force inject (see callers).
          // For later complete events on manifest hosts, skip, static CS ran.
          if (isManifestContentScriptHost(host)) return;
        } catch {
          /* ignore bad url */
        }
      }
    }
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [BRIDGE_FILE],
    });
  } catch (err) {
    console.warn("bridge inject failed", tabId, err);
  }
}

// Static content scripts only auto-inject into pages loaded AFTER install/reload.
// Push the web-app bridge into any open dashboard tabs (including LAN IPs).
async function injectBridgeIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs
        .filter((tab) => tab.url && isDashboardUrl(tab.url))
        .map((tab) => injectBridge(tab.id, { force: true })),
    );
  } catch (err) {
    console.warn("injectBridgeIntoOpenTabs failed", err);
  }
}

async function syncBackendUrl(backendUrl) {
  const next = normalizeBackendUrl(backendUrl);
  if (!next) return getBackendUrl();
  const ok = await setBackendUrl(next);
  return ok ? next : getBackendUrl();
}

// MV3 service worker. Opens the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn("setPanelBehavior failed", err));
  void injectBridgeIntoOpenTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void injectBridgeIntoOpenTabs();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && isDashboardUrl(tab.url)) {
    void injectBridge(tabId);
  }
});

// Fallback for browsers/states where panel behavior is not honored: open on click.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (tab && tab.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (err) {
    console.warn("sidePanel.open failed", err);
  }
});

// Per-engine content-script bundles, injected in dependency order: shared DOM
// utils first (bootstraps window.__AF), then each component driver (self-
// registers), then the engine core, then the picker bridge. Classic content
// scripts share one ISOLATED world per frame, so this is how the pieces find
// each other. The file list order is preserved by executeScript; registration
// is idempotent. The side panel's engine router (src/engines.js) selects which
// bundle to inject by id; a dedicated platform engine ships its own bundle here.
const ENGINE_SCRIPTS = {
  // Greenhouse / generic best-effort: manual region selection + LLM, driven by
  // the platform-agnostic component drivers.
  greenhouse: [
    "content/engine/dom.js",
    "content/engine/greenhouse.js",
    "content/engine/pinpoint.js",
    "content/engine/lever.js",
    "content/engine/workable.js",
    "content/engine/breezy.js",
    "content/engine/manatal.js",
    "content/engine/jobdiva.js",
    "content/engine/jobvite.js",
    "content/engine/ashby.js",
    "content/engine/icims.js",
    "content/engine/drivers/sr-select.js",
    "content/engine/drivers/icims-dropdown.js",
    "content/engine/drivers/native.js",
    "content/engine/drivers/react-select.js",
    "content/engine/drivers/intl-tel-input.js",
    "content/engine/drivers/file.js",
    "content/engine/drivers/group.js",
    "content/engine/drivers/yes-no-buttons.js",
    "content/engine/drivers/editable.js",
    "content/engine/engine.js",
    "content/picker.js",
  ],
  // Workday: dedicated deterministic engine that maps a canonical structured
  // profile to Workday's stable data-automation-id fields (no region selection,
  // no LLM). Order matters: dom primitives -> steps -> engine -> content entry.
  workday: [
    "content/workday/wd-dom.js",
    "content/workday/wd-steps.js",
    "content/workday/wd-engine.js",
    "content/workday/wd-content.js",
  ],
};

function scriptsForEngine(engineId) {
  return ENGINE_SCRIPTS[engineId] || ENGINE_SCRIPTS.greenhouse;
}

// Inject the autofill engine (and its overlay CSS) into every frame of the
// target tab. The side panel requests this after the user has granted host
// permission for the page origin.
// Key under which we stash the job the dashboard asked us to apply to, so the
// side panel can pick it up whether it is already open or opened afterwards.
const PENDING_JOB_KEY = "pendingWebappJob";

attachJobSiteConnectHandlers();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "WEBAPP_EXTENSION_SESSION") {
    (async () => {
      try {
        const from = sender && (sender.url || (sender.tab && sender.tab.url));
        if (!sender || sender.id !== chrome.runtime.id || !isDashboardUrl(from) || !msg.token || !msg.user) {
          sendResponse({ ok: false, error: "Sign-in must come from the NAO website." });
          return;
        }
        await syncBackendUrl(msg.backendUrl || new URL(from).origin);
        await setToken(String(msg.token));
        await setCurrentUser({ user_id: String(msg.user.user_id), email: String(msg.user.email || "") });
        chrome.runtime.sendMessage({ type: "SESSION_CHANGED" }).catch(() => {});
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }

  if (msg && msg.type === "SYNC_BACKEND_URL" && msg.backendUrl) {
    (async () => {
      try {
        const synced = await syncBackendUrl(msg.backendUrl);
        sendResponse({ ok: true, backendUrl: synced });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }
  return false;
});

// The dashboard's "Apply with Assistant" button relays a job here (via the
// content-script bridge). We remember it, open the application URL in a new
// tab, and try to surface the side panel; the panel then loads that job.
//
// DEFENSE: duplicate bridge listeners can deliver WEBAPP_APPLY_JOB more than
// once per click. Sync memory dedupe + a shared in-flight tab-open promise
// guarantee at most one chrome.tabs.create per jobId.
let lastWebappApply = { jobId: null, at: 0 };
const WEBAPP_APPLY_DEDUPE_MS = 2500;
/** @type {Map<string, Promise<void>>} */
const applyTabOpenLocks = new Map();

async function openApplicationTabOnce(jobId, url) {
  if (!url) return;
  const existing = applyTabOpenLocks.get(jobId);
  if (existing) {
    await existing;
    return;
  }
  const work = (async () => {
    let reused = false;
    try {
      const matches = await chrome.tabs.query({ url });
      const hit = (matches || []).find((t) => t.id != null);
      if (hit && hit.id != null) {
        await chrome.tabs.update(hit.id, { active: true });
        if (hit.windowId != null) {
          await chrome.windows.update(hit.windowId, { focused: true }).catch(() => {});
        }
        reused = true;
      }
    } catch {
      /* exact-url query can fail for some schemes */
    }
    if (!reused) {
      await chrome.tabs.create({ url, active: true });
    }
  })().finally(() => {
    // Keep the lock briefly so a lagged duplicate handler joins this open.
    setTimeout(() => {
      if (applyTabOpenLocks.get(jobId) === work) applyTabOpenLocks.delete(jobId);
    }, WEBAPP_APPLY_DEDUPE_MS);
  });
  applyTabOpenLocks.set(jobId, work);
  await work;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!(msg && msg.type === "WEBAPP_APPLY_JOB" && msg.jobId)) return false;

  const jobId = String(msg.jobId);
  const now = Date.now();
  const isDupe =
    lastWebappApply.jobId === jobId && now - lastWebappApply.at < WEBAPP_APPLY_DEDUPE_MS;

  // CRITICAL: open the side panel FIRST, synchronously, before any await.
  // sidePanel.open() may only be called in response to a user gesture, and
  // Chrome drops the gesture flag after ~1ms / the first await. The bridge
  // relays this message from inside the dashboard click, so the gesture is
  // still valid right here (see extension/content/webapp-bridge.js).
  if (msg.openPanel && !isDupe) {
    const windowId = sender && sender.tab && sender.tab.windowId != null ? sender.tab.windowId : null;
    if (windowId != null) {
      chrome.sidePanel
        .open({ windowId })
        .catch((err) => console.warn("sidePanel.open (webapp apply) failed", err));
    }
  }

  if (isDupe) {
    // Still coalesce onto the in-flight tab open if one exists.
    const pending = applyTabOpenLocks.get(jobId);
    if (pending) {
      pending.finally(() => sendResponse({ ok: true, deduped: true }));
      return true;
    }
    sendResponse({ ok: true, deduped: true });
    return false;
  }
  lastWebappApply = { jobId, at: now };

  (async () => {
    try {
      await chrome.storage.session.set({
        [PENDING_JOB_KEY]: { jobId, url: msg.url || null, ts: Date.now() },
      });

      try {
        await openApplicationTabOnce(jobId, msg.url || null);
      } catch (err) {
        console.warn("open application tab failed", err);
      }

      try {
        chrome.runtime.sendMessage({ type: "WEBAPP_OPEN_PENDING_JOB", jobId }, () => {
          void chrome.runtime.lastError;
        });
      } catch (_e) {
        /* no receiver yet; storage fallback covers it */
      }

      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true; // async sendResponse
});

const APP_HELPER_FILES = ["content/ask-hotkey.js", "content/submit-watch.js"];

async function injectAppHelpers(tabId) {
  if (tabId == null) return;
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: APP_HELPER_FILES,
  });
}

async function isAppAssistArmed() {
  try {
    const data = await chrome.storage.session.get("askHotkeyArmed");
    return data && data.askHotkeyArmed === true;
  } catch {
    return false;
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return;
  void (async () => {
    if (!(await isAppAssistArmed())) return;
    try {
      await injectAppHelpers(tabId);
    } catch (err) {
      // Missing host permission is expected until the side panel requests it.
      console.warn("app helpers inject failed", tabId, err);
    }
  })();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "AUTOFILL_INJECT" && msg.tabId != null) {
    (async () => {
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: msg.tabId, allFrames: true },
          files: ["content/overlay.css"],
        });
        // MAIN world first: page-bridge can see React `_valueTracker` / `__reactProps$`
        // that isolated content scripts cannot (Chrome isolated-world boundary).
        try {
          await chrome.scripting.executeScript({
            target: { tabId: msg.tabId, allFrames: true },
            files: ["content/engine/page-bridge.js"],
            world: "MAIN",
          });
        } catch (err) {
          console.warn("page-bridge MAIN inject failed", err);
        }
        await chrome.scripting.executeScript({
          target: { tabId: msg.tabId, allFrames: true },
          files: scriptsForEngine(msg.engine),
        });
        // Keep ask-hotkey + submit-watch available alongside autofill engines.
        try {
          await injectAppHelpers(msg.tabId);
        } catch {
          /* ignore */
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true; // async sendResponse
  }

  if (msg && msg.type === "ASK_HOTKEY_INJECT" && msg.tabId != null) {
    (async () => {
      try {
        await chrome.storage.session.set({ askHotkeyArmed: true });
        await injectAppHelpers(msg.tabId);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }

  if (msg && msg.type === "ASK_HOTKEY_DISARM") {
    chrome.storage.session.set({ askHotkeyArmed: false }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  // Content-script hotkey → stash for the side panel if it missed the message.
  if (msg && msg.type === "ASK_SELECTION") {
    const text = String((msg && msg.text) || "").trim();
    chrome.storage.session
      .set({
        pendingAskSelection: {
          text,
          empty: !text || !!msg.empty,
          at: Date.now(),
        },
      })
      .catch(() => {});
    // Side panel also receives this message via its own onMessage listener.
    sendResponse({ ok: true });
    return false;
  }

  // Application submit detected on the page. Resolve which job it belongs to
  // (the tab the panel opened it in wins over the panel's current job), then
  // hand it to the open panel, or record it here when no panel is open.
  if (msg && msg.type === "APP_SUBMITTED") {
    void handleAppSubmitted(msg, sender);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

const APPLY_TAB_MAX_AGE_MS = 6 * 60 * 60 * 1000;

async function resolveSubmittedJobId(msg, sender) {
  const data = await chrome.storage.session.get(["activeApplyJobId", "applyTabJobs"]);
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const byTab = tabId != null && data.applyTabJobs ? data.applyTabJobs[String(tabId)] : null;
  if (byTab && byTab.jobId && Date.now() - Number(byTab.at || 0) < APPLY_TAB_MAX_AGE_MS) {
    return String(byTab.jobId);
  }
  return String((data && data.activeApplyJobId) || msg.jobId || "");
}

async function isPanelOpen() {
  if (!chrome.runtime.getContexts) return false;
  try {
    const contexts = await chrome.runtime.getContexts({});
    return contexts.some((c) => String(c.documentUrl || "").includes("/sidepanel.html"));
  } catch {
    return false;
  }
}

async function handleAppSubmitted(msg, sender) {
  try {
    // Multi-frame submit-watch and Workday detection can both fire for one
    // submit; a second event must not complete the *next* job.
    const { lastAppSubmittedAt } = await chrome.storage.session.get("lastAppSubmittedAt");
    const now = msg.at || Date.now();
    if (lastAppSubmittedAt && now - Number(lastAppSubmittedAt) < 10_000) return;
    const jobId = await resolveSubmittedJobId(msg, sender);
    if (!jobId) return;
    const report = { reason: msg.reason || "submit", url: msg.url || "", at: now, jobId };
    await chrome.storage.session.set({ lastAppSubmittedAt: now });

    if (await isPanelOpen()) {
      await chrome.storage.session.set({ pendingAppSubmitted: report });
      chrome.runtime.sendMessage({ type: "APP_SUBMITTED_RESOLVED", ...report }).catch(() => {});
      return;
    }
    const marked = await api.markApplied([jobId]);
    if (marked && Number(marked.marked) > 0) {
      api.updateSession(jobId, "completed").catch(() => {});
      await chrome.storage.session.set({ appliedInBackground: { jobId, at: now } });
    }
  } catch (err) {
    console.warn("app submit handling failed", err);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session
    .get("applyTabJobs")
    .then(({ applyTabJobs }) => {
      if (!applyTabJobs || !applyTabJobs[String(tabId)]) return;
      const next = { ...applyTabJobs };
      delete next[String(tabId)];
      return chrome.storage.session.set({ applyTabJobs: next });
    })
    .catch(() => {});
});
