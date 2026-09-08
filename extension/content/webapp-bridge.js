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
//                  bridge -> page  data-atomspace-apply-ack="<requestId>" (sync) + APPLY_ACK postMessage
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

  function originsFor(detail) {
    const origins = Array.isArray(detail.origins) ? detail.origins.filter(Boolean) : [];
    if (origins.length) return origins;
    const domains = Array.isArray(detail.domains) ? detail.domains : [];
    const out = [];
    for (const domain of domains) {
      const host = String(domain || "").replace(/^\./, "");
      if (!host) continue;
      out.push("https://*." + host + "/*");
      out.push("https://" + host + "/*");
    }
    return out;
  }

  // Cookie access is deliberately NOT requested here.
  //
  // chrome.permissions is not one of the APIs Chrome exposes to content
  // scripts — the isolated world only gets dom, i18n, storage and part of
  // runtime. chrome.permissions.request() therefore threw a TypeError on every
  // connect attempt, and the old catch reported it to the dashboard as the
  // opaque "extension_error". Relaying it to the worker instead does not help:
  // a gesture only survives a sendMessage hop when it starts in an extension
  // UI context, not a content script.
  //
  // So the grant now happens in the side panel, which is an extension page and
  // has both the API and a real click. The worker opens that panel using the
  // gesture we are still holding inside this handler, which is why every relay
  // below must stay synchronous — no await before sendMessage.
  function describeError(err) {
    return "extension_error: " + ((err && err.message) || String(err || "unknown"));
  }

  const CAPTURE_EVENT = "atomspace-capture-session";
  document.addEventListener(CAPTURE_EVENT, function (event) {
    let detail = null;
    try {
      detail = JSON.parse(event.detail);
    } catch (_e) {
      return;
    }
    if (!detail || !detail.slug) return;
    const requestId = detail.requestId || null;
    const origins = originsFor(detail);
    const domains = Array.isArray(detail.domains) ? detail.domains : [];

    try {
      chrome.runtime.sendMessage(
        {
          type: "GET_JOB_SITE_COOKIES",
          domains: domains,
          origins: origins,
          slug: detail.slug,
        },
        function (resp) {
          void chrome.runtime.lastError;
          reply(
            "CAPTURE_JOB_SITE_SESSION_RESULT",
            Object.assign({ requestId: requestId }, resp || { ok: false, error: "no_response" }),
            "*",
          );
        },
      );
    } catch (err) {
      reply(
        "CAPTURE_JOB_SITE_SESSION_RESULT",
        { requestId: requestId, ok: false, error: describeError(err) },
        "*",
      );
    }
  });

  const CONNECT_EVENT = "atomspace-connect-job-site";
  document.addEventListener(CONNECT_EVENT, function (event) {
    let detail = null;
    try {
      detail = JSON.parse(event.detail);
    } catch (_e) {
      return;
    }
    if (!detail || !detail.slug) return;
    const requestId = detail.requestId || null;
    const origins = originsFor(detail);

    try {
      chrome.runtime.sendMessage(
        {
          type: "START_JOB_SITE_CONNECT",
          requestId: requestId,
          slug: detail.slug,
          name: detail.name || detail.slug,
          loginUrl: detail.loginUrl || "",
          origins: origins,
          domains: Array.isArray(detail.domains) ? detail.domains : [],
          signedInUrlPatterns: Array.isArray(detail.signedInUrlPatterns)
            ? detail.signedInUrlPatterns
            : [],
          sessionCookieNames: Array.isArray(detail.sessionCookieNames)
            ? detail.sessionCookieNames
            : [],
          loginPathPatterns: Array.isArray(detail.loginPathPatterns)
            ? detail.loginPathPatterns
            : [],
        },
        function (resp) {
          void chrome.runtime.lastError;
          if (!resp || !resp.ok) {
            reply(
              "CONNECT_JOB_SITE_SESSION_RESULT",
              {
                requestId: requestId,
                ok: false,
                error: (resp && resp.error) || "no_response",
              },
              "*",
            );
            return;
          }
          reply(
            "CONNECT_JOB_SITE_SESSION_STARTED",
            {
              requestId: requestId,
              ok: true,
              loginTabId: resp.loginTabId || null,
              awaitingPermission: Boolean(resp.awaitingPermission),
            },
            "*",
          );
        },
      );
    } catch (err) {
      reply(
        "CONNECT_JOB_SITE_SESSION_RESULT",
        { requestId: requestId, ok: false, error: describeError(err) },
        "*",
      );
    }
  });

  const ABORT_EVENT = "atomspace-abort-job-site-connect";
  document.addEventListener(ABORT_EVENT, function (event) {
    let detail = null;
    try {
      detail = JSON.parse(event.detail || "{}");
    } catch (_e) {
      detail = {};
    }
    try {
      chrome.runtime.sendMessage(
        {
          type: "ABORT_JOB_SITE_CONNECT",
          requestId: (detail && detail.requestId) || null,
          error: (detail && detail.error) || "cancelled",
        },
        function () {
          void chrome.runtime.lastError;
        },
      );
    } catch (_e) {
      /* extension context invalidated */
    }
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== "JOB_SITE_CONNECT_RESULT") return;
    reply(
      "CONNECT_JOB_SITE_SESSION_RESULT",
      {
        requestId: msg.requestId || null,
        ok: Boolean(msg.ok),
        cookies: msg.cookies || [],
        error: msg.error || null,
      },
      "*",
    );
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
