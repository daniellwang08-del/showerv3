// Dashboard origins: production (robertstaff.com), localhost, and private LAN.
// Chrome match patterns ignore ports, so LAN inject covers any Vite port (e.g. :5173).

import { getBackendUrl, normalizeBackendUrl, setBackendUrl } from "./src/store.js";
import { isDashboardUrl } from "./src/backendOrigin.js";

const BRIDGE_FILE = "content/webapp-bridge.js";

async function injectBridge(tabId) {
  if (tabId == null) return;
  try {
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
      tabs.filter((tab) => tab.url && isDashboardUrl(tab.url)).map((tab) => injectBridge(tab.id)),
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
    "content/engine/drivers/sr-select.js",
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!(msg && msg.type === "WEBAPP_APPLY_JOB" && msg.jobId)) return false;

  // CRITICAL: open the side panel FIRST, synchronously, before any await.
  // sidePanel.open() may only be called in response to a user gesture, and
  // Chrome drops the gesture flag after ~1ms / the first await. The bridge
  // relays this message from inside the dashboard click, so the gesture is
  // still valid right here (see extension/content/webapp-bridge.js).
  if (msg.openPanel) {
    const windowId = sender && sender.tab && sender.tab.windowId != null ? sender.tab.windowId : null;
    if (windowId != null) {
      chrome.sidePanel
        .open({ windowId })
        .catch((err) => console.warn("sidePanel.open (webapp apply) failed", err));
    }
  }

  (async () => {
    try {
      // Remember the job so the panel loads it once it boots.
      await chrome.storage.session.set({
        [PENDING_JOB_KEY]: { jobId: String(msg.jobId), url: msg.url || null, ts: Date.now() },
      });

      // Open the application page in a new tab (same window keeps the global
      // side panel visible).
      if (msg.url) {
        try {
          await chrome.tabs.create({ url: msg.url, active: true });
        } catch (err) {
          console.warn("open application tab failed", err);
        }
      }

      // If the panel is already open, tell it to load the job right away.
      try {
        chrome.runtime.sendMessage({ type: "WEBAPP_OPEN_PENDING_JOB", jobId: String(msg.jobId) }, () => {
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

  // Application submit detected on the page → side panel Complete & Next.
  // Bind to activeApplyJobId and globally debounce so multi-frame submit-watch
  // + Workday detect cannot stash a second event that completes the *next* job.
  if (msg && msg.type === "APP_SUBMITTED") {
    chrome.storage.session
      .get(["activeApplyJobId", "lastAppSubmittedAt"])
      .then((data) => {
        const now = msg.at || Date.now();
        const last = Number((data && data.lastAppSubmittedAt) || 0);
        if (last && now - last < 10_000) return;
        const jobId = (data && data.activeApplyJobId) || msg.jobId || "";
        return chrome.storage.session.set({
          lastAppSubmittedAt: now,
          pendingAppSubmitted: {
            reason: msg.reason || "submit",
            url: msg.url || "",
            at: now,
            jobId: jobId ? String(jobId) : "",
          },
        });
      })
      .catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
