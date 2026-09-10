// Web-app <-> extension bridge (content script).
//
// Runs on the Job-Scraper dashboard origin. It exists so the dashboard can:
//   1. DETECT that this extension is installed (PING -> PONG handshake),
//   2. HAND OFF a specific job to apply ("Apply with Assistant" button) AND open
//      the side panel, and
//   3. CONNECT a job-site account: the worker opens the board in a real tab,
//      tracks navigation until it settles, and captures the session when the
//      final URL is the signed-in page (e.g. jobright.ai/jobs/recommend).
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
//                  bridge -> page  data-atomspace-apply-ack="<requestId>" (sync) + APPLY_ACK postMessage
//   JOB SITE:      page postMessage START_JOB_SITE_CONNECT {session}
//                  bridge -> worker; ACK START_JOB_SITE_CONNECT_ACK
//                  worker -> page JOB_SITE_LOG | JOB_SITE_CONNECT_STATUS
//                                 | JOB_SITE_SESSION
//
// IDEMPOTENCY (critical):
//   background.js also executeScript-injects this file on install/startup.
//   Without a guard, each inject adds another APPLY_EVENT listener → N× tabs.
//   sendMessage is also deduped via a shared globalThis slot so stacked
//   listeners from older builds cannot enqueue multiple WEBAPP_APPLY_JOB msgs.

(function () {
  "use strict";

  // Same isolated world for this extension — survives repeated executeScript.
  if (globalThis.__ATOMSPACE_WEBAPP_BRIDGE_INSTALLED__) return;
  globalThis.__ATOMSPACE_WEBAPP_BRIDGE_INSTALLED__ = true;

  const WEBAPP_SOURCE = "atomspace-webapp";
  const EXT_SOURCE = "atomspace-extension";
  const APPLY_EVENT = "atomspace-apply";
  const ACK_ATTR = "data-atomspace-apply-ack";
  const APPLY_DEDUPE_MS = 2500;

  // Shared across any bridge copies that somehow still share this world.
  const applyDedupe =
    globalThis.__ATOMSPACE_APPLY_DEDUPE__ ||
    (globalThis.__ATOMSPACE_APPLY_DEDUPE__ = { jobId: null, at: 0 });

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

  function ackPage(requestId) {
    try {
      if (requestId) document.documentElement.setAttribute(ACK_ATTR, String(requestId));
    } catch (_e) {
      /* ignore */
    }
    reply("APPLY_ACK", { requestId: requestId || null }, "*");
  }

  const JOB_SITE_PREFIX = "[atomspace:jobsite:bridge]";
  const JOB_SITE_TYPES = {
    START_JOB_SITE_CONNECT: true,
    STOP_JOB_SITE_CONNECT: true,
    CAPTURE_JOB_SITE_NOW: true,
    FOCUS_JOB_SITE_TAB: true,
  };

  function forwardJobSite(data, targetOrigin) {
    const type = data.type;
    const requestId = data.requestId || null;
    console.log(JOB_SITE_PREFIX + " page -> worker", { type: type, session: data.session || null });
    try {
      chrome.runtime.sendMessage(
        {
          type: type,
          requestId: requestId,
          session: data.session || null,
          keepTab: data.keepTab === true,
        },
        function (response) {
          void chrome.runtime.lastError;
          const payload = response && typeof response === "object" ? response : { ok: false };
          console.log(JOB_SITE_PREFIX + " worker -> page", { type: type, response: payload });
          reply(type + "_ACK", Object.assign({ requestId: requestId }, payload), targetOrigin);
        },
      );
    } catch (_e) {
      console.warn(JOB_SITE_PREFIX + " extension context invalidated", type);
      reply(
        type + "_ACK",
        {
          requestId: requestId,
          ok: false,
          error: "Extension context invalidated. Reload the extension.",
        },
        targetOrigin,
      );
    }
  }

  // Detection handshake + job-site connect (async is fine; no user gesture).
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== WEBAPP_SOURCE || typeof data.type !== "string") return;
    if (data.type === "PING") {
      reply("PONG", { requestId: data.requestId || null }, event.origin || "*");
      return;
    }
    if (JOB_SITE_TYPES[data.type]) {
      forwardJobSite(data, event.origin || "*");
    }
  });

  // Background → dashboard (navigation logs, status updates, captured session).
  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type.indexOf("JOB_SITE_") !== 0) return;
      if (msg.type === "JOB_SITE_LOG") {
        const line = JOB_SITE_PREFIX + " " + msg.event;
        if (msg.level === "warn") console.warn(line, msg.detail);
        else console.log(line, msg.detail);
      } else {
        console.log(JOB_SITE_PREFIX + " " + msg.type, msg);
      }
      const extra = Object.assign({}, msg);
      delete extra.type;
      reply(msg.type, extra, "*");
    });
  } catch (_e) {
    /* extension context invalidated */
  }

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

    const jobId = String(detail.jobId);
    const requestId = detail.requestId || null;
    const now = Date.now();
    const isDupe =
      applyDedupe.jobId === jobId && now - applyDedupe.at < APPLY_DEDUPE_MS;

    // Always ACK so the page never falls back to window.open (that was the
    // second tab when postMessage ACK was missed). Only the first handler in
    // the dedupe window sends WEBAPP_APPLY_JOB.
    if (!isDupe) {
      applyDedupe.jobId = jobId;
      applyDedupe.at = now;
      try {
        chrome.runtime.sendMessage(
          {
            type: "WEBAPP_APPLY_JOB",
            jobId: jobId,
            url: detail.url || null,
            openPanel: true,
          },
          function () {
            void chrome.runtime.lastError;
          },
        );
      } catch (_e) {
        /* extension context invalidated (e.g. just updated) */
      }
    }

    ackPage(requestId);
  });

  // Proactively announce presence for listeners that attach before their PING.
  reply("READY", {}, "*");

  // Sync backend URL from the dashboard origin.
  try {
    chrome.runtime.sendMessage(
      { type: "SYNC_BACKEND_URL", backendUrl: location.origin },
      function () {
        void chrome.runtime.lastError;
      },
    );
  } catch (_e) {
    /* extension context invalidated */
  }
})();
