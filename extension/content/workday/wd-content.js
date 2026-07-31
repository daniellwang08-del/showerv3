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
  // runSeq from the side panel; Stop bumps minRunSeq so late WD_RUN / in-flight
  // work from the cancelled attempt is ignored immediately.
  WD.minRunSeq = WD.minRunSeq || 0;
  WD.epoch = WD.epoch || 0;
  WD.aborted = false;
  WD._failedFields = WD._failedFields || new Set();

  WD.isAborted = () => !!WD.aborted;

  function clearResolveWaiters() {
    const waiters = WD && WD._waiters;
    if (!waiters) return;
    for (const id of Object.keys(waiters)) {
      try {
        waiters[id]({});
      } catch {}
      delete waiters[id];
    }
  }

  function beginRun(runSeq, options) {
    WD.aborted = false;
    WD._runSeq = runSeq;
    WD.isAborted = () => !!WD.aborted || (runSeq != null && runSeq < (WD.minRunSeq || 0));
    if (options && options.newAttempt) {
      WD._failedFields = new Set();
    } else {
      WD._failedFields = WD._failedFields || new Set();
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "WD_DETECT") {
      const step = WD && WD.engine ? WD.engine.detectStep() : null;
      sendResponse({ step, href: location.href });
      return true;
    }

    // Immediate stop from the side panel. Invalidates the current runSeq so a
    // WD_RUN already in the message queue cannot restart after Stop. Bumping
    // epoch aborts in-flight D.delay/waitFor captured at the old epoch.
    if (msg.type === "WD_ABORT") {
      const minSeq = Number(msg.minRunSeq) || 0;
      if (minSeq > (WD.minRunSeq || 0)) WD.minRunSeq = minSeq;
      WD.epoch = (WD.epoch || 0) + 1;
      WD.aborted = true;
      clearResolveWaiters();
      sendResponse({ ok: true, running });
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
        aborted: !!(WD.isAborted && WD.isAborted()),
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
        if (WD.isAborted && WD.isAborted()) {
          return sendResponse({ ok: false, advanced: false, aborted: true });
        }
        const before = WD.engine.detectStep();
        const ok = await WD.engine.clickNext();
        // Give Workday time to navigate / re-render the next step.
        for (let i = 0; i < 20; i++) {
          if (WD.isAborted && WD.isAborted()) break;
          try {
            await WD.dom.delay(300);
          } catch (e) {
            if (e && e.name === "WDAborted") break;
            throw e;
          }
          if (WD.engine.detectStep() !== before) break;
        }
        const after = WD.engine.detectStep();
        // "generic" is only a detectStep fallback when headings briefly unmount
        // during a validation re-render. Treating myInfo→generic as advanced made
        // the side-panel loop re-run a FULL fill on the same My Information page
        // (seen as many identical step reports, then recovery fills failing).
        const advanced = !!ok && !!after && after !== before && after !== "generic";
        sendResponse({
          ok,
          before,
          after,
          advanced,
          aborted: !!(WD.isAborted && WD.isAborted()),
        });
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

    const runSeq = msg.runSeq != null ? Number(msg.runSeq) : 0;
    // Late WD_RUN from a Stop'd attempt — do not start filling again.
    if (runSeq && runSeq < (WD.minRunSeq || 0)) {
      send({ type: "WD_DONE", reports: [], aborted: true, runSeq });
      return;
    }

    // Only the frame that actually shows a Workday step acts.
    const step = WD.engine.detectStep();
    if (!step) return;
    if (running) {
      // A new explicit run replaces an orphan; abort the prior cooperative loops.
      WD.aborted = true;
      clearResolveWaiters();
    }
    beginRun(runSeq, msg.options || {});
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
        send({
          type: "WD_DONE",
          reports,
          aborted: !!(WD.isAborted && WD.isAborted()),
          runSeq,
        });
      } catch (e) {
        if (e && e.name === "WDAborted") {
          send({ type: "WD_DONE", reports, aborted: true, runSeq });
        } else {
          send({ type: "WD_ERROR", error: String((e && e.message) || e), reports });
        }
      } finally {
        running = false;
      }
    })();
  });

  try {
    WD.log("engine ready", location.href);
  } catch {}
})();
