// Workday engine - content-script entry point.
//
// Injected into all frames. Listens for WD_RUN from the side panel, runs the
// engine on whichever frame actually contains the Workday form (others stay
// silent), and streams progress/done/error back. Also reports the detected
// step on WD_DETECT so the panel can show what it sees before running.
(() => {
  if (window.__WD_CONTENT__) return;
  window.__WD_CONTENT__ = true;
  const WD = window.__WD;

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch {}
  }

  let running = false;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "WD_DETECT") {
      const step = WD && WD.engine ? WD.engine.detectStep() : null;
      sendResponse({ step, href: location.href });
      return true;
    }

    // Auto-advance orchestration (driven step-by-step from the side panel, which
    // is the only context that can focus the tab to flush deferred commits).
    if (msg.type === "WD_FLUSH") {
      // Force any legacy deferred commits; new builds commit inline without OS focus.
      try {
        WD && WD.steps && WD.steps.flush && WD.steps.flush();
      } catch {}
      sendResponse({
        ok: true,
        hasFocus: document.hasFocus(),
        pending: (WD && WD._pendingCommits && WD._pendingCommits.length) || 0,
      });
      return true;
    }

    if (msg.type === "WD_VALIDATE") {
      const v = WD && WD.engine ? WD.engine.detectValidation() : { clean: true, invalidFields: [], errorCount: 0 };
      sendResponse(v);
      return true;
    }

    if (msg.type === "WD_NEXT") {
      (async () => {
        if (!WD || !WD.engine) return sendResponse({ ok: false, advanced: false });
        const before = WD.engine.detectStep();
        const ok = await WD.engine.clickNext();
        // Give Workday time to navigate / re-render the next step.
        for (let i = 0; i < 20; i++) {
          await WD.dom.delay(300);
          if (WD.engine.detectStep() !== before) break;
        }
        const after = WD.engine.detectStep();
        sendResponse({ ok, before, after, advanced: !!ok && after !== before });
      })();
      return true;
    }

    // Result of an async value-resolution request (e.g. LLM degree matching)
    // the engine fired via WD_RESOLVE; hand it to the waiting promise by id.
    if (msg.type === "WD_RESOLVE_RESULT") {
      try {
        const w = WD && WD._waiters && WD._waiters[msg.requestId];
        if (w) w(msg.values || {});
      } catch {}
      return;
    }

    if (msg.type !== "WD_RUN") return;
    if (!WD || !WD.engine) {
      send({ type: "WD_ERROR", error: "Workday engine not loaded" });
      return;
    }
    // Only the frame that actually shows a Workday step acts.
    const step = WD.engine.detectStep();
    if (!step) return;
    if (running) return;
    running = true;

    (async () => {
      const reports = [];
      try {
        await WD.engine.runAll(msg.profile || {}, msg.options || {}, (r) => {
          reports.push(r);
          try {
            WD.log("step report", r.step, JSON.parse(JSON.stringify(r)));
          } catch {}
          send({ type: "WD_PROGRESS", report: r });
        });
        send({ type: "WD_DONE", reports });
      } catch (e) {
        send({ type: "WD_ERROR", error: String((e && e.message) || e), reports });
      } finally {
        running = false;
      }
    })();
  });

  try {
    WD.log("engine ready", location.href);
  } catch {}
})();
