// Runs on the job-site tab only while an Integrations connect is in progress
// (registered dynamically by src/jobSiteConnect.js).
//
// webNavigation misses purely client-side route swaps that never touch
// history (Jobright re-renders /jobs/recommend into a login view). Polling
// location.href plus readyState is what makes "did it stay on the signed-in
// page?" reliable. Everything is logged in the PAGE console so a user can
// screenshot exactly what the board did.
(function () {
  "use strict";

  if (globalThis.__NAO_JOB_SITE_WATCH__) return;
  globalThis.__NAO_JOB_SITE_WATCH__ = true;

  var PREFIX = "[nao:jobsite:page]";
  var POLL_MS = 500;
  var lastUrl = "";
  var lastReadyState = "";

  function send(source) {
    var url = String(location.href || "");
    var readyState = document.readyState;
    console.log(PREFIX + " report", { source: source, url: url, readyState: readyState });
    try {
      chrome.runtime.sendMessage(
        {
          type: "JOB_SITE_PAGE_REPORT",
          source: source,
          url: url,
          readyState: readyState,
          title: document.title || "",
        },
        function () {
          void chrome.runtime.lastError;
        },
      );
    } catch (_e) {
      // Extension reloaded/disabled, stop polling so we don't spam the page.
      if (pollTimer) clearInterval(pollTimer);
    }
  }

  console.log(PREFIX + " attached", { url: location.href });
  send("attach");

  document.addEventListener("readystatechange", function () {
    console.log(PREFIX + " readystatechange", document.readyState);
    send("readystatechange");
  });
  window.addEventListener("load", function () {
    send("load");
  });
  window.addEventListener("pageshow", function () {
    send("pageshow");
  });
  window.addEventListener("popstate", function () {
    send("popstate");
  });
  window.addEventListener("hashchange", function () {
    send("hashchange");
  });

  var pollTimer = setInterval(function () {
    var url = String(location.href || "");
    if (url !== lastUrl || document.readyState !== lastReadyState) {
      lastUrl = url;
      lastReadyState = document.readyState;
      send("url_poll");
    }
  }, POLL_MS);
})();
