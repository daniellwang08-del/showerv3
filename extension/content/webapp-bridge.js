// Web-app <-> extension bridge (content script).
//
// Runs on the Job-Scraper dashboard origin. It exists so the dashboard can:
//   1. DETECT that this extension is installed (PING -> PONG handshake), and
//   2. HAND OFF a specific job to apply ("Apply with Assistant" button) AND open
//      the side panel.
//
// WHY A CustomEvent (not postMessage) FOR APPLY:
//   chrome.sidePanel.open() may only be called in response to a user gesture,
//   and Chrome drops the gesture flag after any async gap. User activation does
//   NOT survive window.postMessage (it runs in a separate task). A synchronous
//   DOM CustomEvent handler, however, runs inside the same click task, so the
//   gesture is still active when we message the worker -> the worker can open
//   the panel. Detail is passed as a JSON string so it crosses the isolated
//   world cleanly.
//
// Contract:
//   PING (detect): page window.postMessage {source:"atomspace-webapp",type:"PING",requestId}
//                  bridge window.postMessage {source:"atomspace-extension",type:"PONG",version,requestId}
//   APPLY (open):  page document.dispatchEvent(new CustomEvent("atomspace-apply",
//                    { detail: JSON.stringify({ jobId, url, requestId }) }))
//                  bridge -> worker chrome.runtime.sendMessage {type:"WEBAPP_APPLY_JOB", jobId, url, openPanel:true}
//                  bridge -> page  window.postMessage {source:"atomspace-extension",type:"APPLY_ACK",jobId,requestId}

(function () {
  "use strict";

  const WEBAPP_SOURCE = "atomspace-webapp";
  const EXT_SOURCE = "atomspace-extension";
  const APPLY_EVENT = "atomspace-apply";

  let version = "";
  try {
    version = chrome.runtime.getManifest().version || "";
  } catch (_e) {
    version = "";
  }

  function reply(type, extra, targetOrigin) {
    try {
      window.postMessage(
        Object.assign({ source: EXT_SOURCE, type: type, version: version }, extra || {}),
        targetOrigin || "*",
      );
    } catch (_e) {
      /* page navigated away */
    }
  }

  // Detection handshake (async is fine here; no user gesture involved).
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== WEBAPP_SOURCE || typeof data.type !== "string") return;
    if (data.type === "PING") {
      reply("PONG", { requestId: data.requestId || null }, event.origin || "*");
    }
  });

  // Apply hand-off. Runs SYNCHRONOUSLY inside the user's click, so the worker
  // can open the side panel. Do NOT await anything before sendMessage.
  document.addEventListener(APPLY_EVENT, function (event) {
    let detail = null;
    try {
      detail = JSON.parse(event.detail);
    } catch (_e) {
      return;
    }
    if (!detail || !detail.jobId) return;

    try {
      chrome.runtime.sendMessage(
        {
          type: "WEBAPP_APPLY_JOB",
          jobId: String(detail.jobId),
          url: detail.url || null,
          openPanel: true,
        },
        function () {
          // Swallow "receiving end does not exist" when the worker is asleep.
          void chrome.runtime.lastError;
        },
      );
    } catch (_e) {
      /* extension context invalidated (e.g. just updated) */
    }

    reply("APPLY_ACK", { jobId: detail.jobId, requestId: detail.requestId || null }, "*");
  });

  // Proactively announce presence for listeners that attach before their PING.
  reply("READY", {}, "*");
})();
