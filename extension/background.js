// MV3 service worker. Opens the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn("setPanelBehavior failed", err));
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

// Modular autofill engine, injected in dependency order: shared DOM utils first
// (bootstraps window.__AF), then each component driver (self-registers), then
// the engine core, then the picker bridge. Classic content scripts share one
// ISOLATED world per frame, so this is how the pieces find each other. The file
// list order is preserved by executeScript; registration is idempotent.
const AUTOFILL_SCRIPTS = [
  "content/engine/dom.js",
  "content/engine/drivers/native.js",
  "content/engine/drivers/react-select.js",
  "content/engine/drivers/intl-tel-input.js",
  "content/engine/drivers/file.js",
  "content/engine/drivers/group.js",
  "content/engine/drivers/editable.js",
  "content/engine/engine.js",
  "content/picker.js",
];

// Inject the autofill engine (and its overlay CSS) into every frame of the
// target tab. The side panel requests this after the user has granted host
// permission for the page origin.
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
          files: AUTOFILL_SCRIPTS,
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
