// Origins where the dashboard runs (match the manifest content_scripts). Chrome
// match patterns ignore ports, so these cover any dev port (e.g. :5173).
const WEBAPP_MATCHES = ["http://localhost/*", "http://127.0.0.1/*", "https://localhost/*"];

// Static content scripts only auto-inject into pages loaded AFTER the extension
// is installed/reloaded. So when we install (or the browser starts), push the
// web-app bridge into any dashboard tabs that are already open — otherwise the
// dashboard's "is the extension installed?" handshake finds nothing until the
// user manually reloads the page.
async function injectBridgeIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: WEBAPP_MATCHES });
    await Promise.all(
      tabs.map((tab) =>
        tab.id == null
          ? Promise.resolve()
          : chrome.scripting
              .executeScript({ target: { tabId: tab.id, allFrames: false }, files: ["content/webapp-bridge.js"] })
              .catch((err) => console.warn("bridge inject failed", tab.id, err)),
      ),
    );
  } catch (err) {
    console.warn("injectBridgeIntoOpenTabs failed", err);
  }
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
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true; // async sendResponse
  }
  return false;
});
