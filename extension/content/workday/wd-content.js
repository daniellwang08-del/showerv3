// Workday engine - content-script entry point.
//
// Injected into all frames. Listens for WD_RUN from the side panel, runs the
// engine on whichever frame actually contains the Workday form (others stay
// silent), and streams progress/done/error back. Also reports the detected
// step on WD_DETECT so the panel can show what it sees before running.
(() => {
  const WD = (window.__WD = window.__WD || {});
  const BUILD = "2026-08-07-lazy-mount-rescan-v23";

  // Page-console bridge MUST re-bind on every executeScript inject. The rest of
  // this file early-returns when __WD_CONTENT__ is set, which previously left
  // stale builds without ACK_A/ACK_B handlers (postMessage probes got silence).
  function installAckProbeBridge() {
    if (typeof window.__WD_ACK_PROBE_HANDLER__ === "function") {
      try {
        window.removeEventListener("message", window.__WD_ACK_PROBE_HANDLER__);
      } catch {}
    }
    const handler = (ev) => {
      const data = ev && ev.data;
      if (!data || data.source !== "af-wd-probe") return;
      if (data.type !== "ACK_A" && data.type !== "ACK_B") return;
      (async () => {
        const reply = (payload) => {
          const body = { build: BUILD, href: location.href, ...payload };
          try {
            WD.log("[ACK probe]", body);
          } catch {}
          try {
            console.log("[ACK probe]", body);
          } catch {}
          // Post on this frame AND top so a page Console on `top` always hears it
          // (form often lives in an iframe content-script world).
          const msg = { source: "af-wd-probe-result", ...body };
          try {
            window.postMessage(msg, "*");
          } catch {}
          try {
            if (window.top && window.top !== window) window.top.postMessage(msg, "*");
          } catch {}
        };
        try {
          if (!WD || !WD.steps) {
            reply({
              ok: false,
              error: "WD.steps missing — click Start/Again in Atomspace first (injects Workday engine)",
            });
            return;
          }
          const S = WD.steps;
          const c = [...document.querySelectorAll('[data-automation-id^="formField-"]')].find((el) =>
            /acknowledg|generative\s*ai|personally participate|unauthorized assistance/i.test(S.fieldLabel(el)),
          );
          if (!c) {
            reply({
              ok: false,
              error: "Acknowledgment formField not found in this frame",
              formFieldCount: document.querySelectorAll('[data-automation-id^="formField-"]').length,
            });
            return;
          }
          const label = S.fieldLabel(c);
          const key = (c.getAttribute("data-automation-id") || "").replace(/^formField-/, "");
          const trigger = S.listboxTrigger ? S.listboxTrigger(c) : null;
          if (data.type === "ACK_A") {
            const resolved = S.resolveByLabel(label, {
              eeo: { disability: false },
              name: {},
              education: [],
            });
            reply({
              ok: true,
              probe: "A",
              key,
              labelLen: (label || "").length,
              labelHead: (label || "").slice(0, 160),
              required: S.isRequired(c),
              filled: S.fieldIsFilled ? S.fieldIsFilled(c) : null,
              hasCommitted: S.fieldHasCommittedValue ? S.fieldHasCommittedValue(c) : null,
              shown: ((trigger && (trigger.textContent || trigger.value)) || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 120),
              triggerTag: trigger && trigger.tagName,
              resolveByLabel: resolved,
              ruleChecks: {
                acknowledgmentWord: /acknowledgment/i.test(label),
                iAcknowledgeThatI: /i acknowledge that i/i.test(label),
                generativeAI: /generative ai platforms/i.test(label),
                unauthorizedAssistance: /unauthorized assistance during the interview/i.test(label),
                bareDisab: /disab/i.test(label),
                oldAckOnly:
                  /please enter ["']?yes["']? if you acknowledge|acknowledge that i have read|answered them truthfully and accurately/i.test(
                    label,
                  ),
              },
              failedFields: WD._failedFields ? [...WD._failedFields] : [],
            });
            return;
          }
          const value = S.resolveByLabel(label, { eeo: {}, name: {} });
          const opts = trigger && S.harvestOptions ? await S.harvestOptions(trigger) : [];
          const expanded = value && S.matchOptionFromList ? S.matchOptionFromList(value, opts) : null;
          const shownBefore = ((trigger && (trigger.textContent || trigger.value)) || "")
            .replace(/\s+/g, " ")
            .trim();
          const writeOk = S.writeField ? await S.writeField(c, value, label) : null;
          const shownAfter = ((trigger && (trigger.textContent || trigger.value)) || "")
            .replace(/\s+/g, " ")
            .trim();
          reply({
            ok: true,
            probe: "B",
            value,
            opts,
            expanded,
            shownBefore,
            writeOk,
            shownAfter,
            stillSelectOne: /^select\s*one/i.test(shownAfter),
          });
        } catch (e) {
          reply({ ok: false, error: String((e && e.message) || e) });
        }
      })();
    };
    window.__WD_ACK_PROBE_HANDLER__ = handler;
    window.addEventListener("message", handler);
    try {
      document.documentElement.setAttribute("data-af-wd-build", BUILD);
    } catch {}
    try {
      WD.log("wd-content probe bridge:", BUILD, location.href);
    } catch {}
  }
  installAckProbeBridge();

  if (window.__WD_CONTENT__) return;
  window.__WD_CONTENT__ = true;
  // const WD already set above

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch {}
  }

  let running = false;
  // Monotonic id so a superseded run's `finally` cannot clear `running` for the
  // active fill (race after myInfo→experience advance caused false WD_ABORTED).
  let activeRunId = 0;
  // runSeq from the side panel; Stop bumps minRunSeq so late WD_RUN / in-flight
  // work from the cancelled attempt is ignored immediately.
  WD.minRunSeq = WD.minRunSeq || 0;
  WD.epoch = WD.epoch || 0;
  WD.aborted = false;
  WD._failedFields = WD._failedFields || new Set();

  WD.isAborted = () => !!WD.aborted;

  // Human-readable phase status for the side panel (not only end-of-step reports).
  WD.reportPhase = (status, detail) => {
    const text = String(status || "").trim();
    if (!text) return;
    try {
      if (WD.aa) WD.aa("phase", { status: text, detail: detail || null });
    } catch {}
    send({ type: "WD_PHASE", status: text, detail: detail || null });
  };

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
      let heading =
        WD && WD.dom && WD.dom.pageHeadingText ? WD.dom.pageHeadingText() : "";
      // Prefer the Application Questions title when present (not the job-title h1).
      if (
        step &&
        String(step).indexOf("questions") === 0 &&
        WD.dom &&
        WD.dom.pageHeadingContaining
      ) {
        heading = WD.dom.pageHeadingContaining("Application Question") || heading;
      }
      sendResponse({ step, heading, href: location.href });
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
        const stepHeading = (stepHint) => {
          if (
            stepHint &&
            String(stepHint).indexOf("questions") === 0 &&
            WD.dom &&
            WD.dom.pageHeadingContaining
          ) {
            return WD.dom.pageHeadingContaining("Application Question") || "";
          }
          return WD.dom && WD.dom.pageHeadingText ? WD.dom.pageHeadingText() : "";
        };
        const before = WD.engine.detectStep();
        const beforeHeading = stepHeading(before);
        const ok = await WD.engine.clickNext();
        // Poll for real next step. Mid-nav often returns step:null briefly —
        // do NOT treat that as advanced=false and stop (DraftKings logs: myInfo→null
        // then experience ~600ms later; panel then burned 1600ms on slow-nav).
        for (let i = 0; i < 22; i++) {
          if (WD.isAborted && WD.isAborted()) break;
          try {
            await WD.dom.delay(i < 8 ? 100 : 150);
          } catch (e) {
            if (e && e.name === "WDAborted") break;
            throw e;
          }
          const now = WD.engine.detectStep();
          const nowHeading = stepHeading(now) || stepHeading(before);
          // Still unmounting / generic flash — keep polling.
          if (!now || now === "generic") continue;
          if (now !== before) break;
          // Application Questions 1 of 2 → 2 of 2 must count even if an older
          // build collapsed both to "questions" (heading text still changes).
          if (beforeHeading && nowHeading && nowHeading !== beforeHeading) break;
        }
        const after = WD.engine.detectStep();
        const afterHeading = stepHeading(after) || stepHeading(before);
        // "generic" is only a detectStep fallback when headings briefly unmount
        // during a validation re-render. Treating myInfo→generic as advanced made
        // the side-panel loop re-run a FULL fill on the same My Information page
        // (seen as many identical step reports, then recovery fills failing).
        const stepChanged = !!after && after !== before && after !== "generic";
        const headingChanged =
          !!(beforeHeading && afterHeading && afterHeading !== beforeHeading);
        const advanced = !!ok && (stepChanged || headingChanged);
        try {
          WD.log(
            "[AA] WD_NEXT " +
              JSON.stringify({
                ok,
                before,
                after,
                beforeHeading,
                afterHeading,
                stepChanged,
                headingChanged,
                advanced,
              }),
          );
        } catch {}
        try {
          if (WD.aa) {
            WD.aa("WD_NEXT", {
              ok,
              before,
              after,
              beforeHeading: String(beforeHeading || "").slice(0, 100),
              afterHeading: String(afterHeading || "").slice(0, 100),
              stepChanged,
              headingChanged,
              advanced,
            });
          }
        } catch {}
        sendResponse({
          ok,
          before,
          after,
          beforeHeading,
          afterHeading,
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
      // A new explicit run replaces an orphan; abort the prior cooperative loops
      // and bump epoch so in-flight D.delay from the old run rejects cleanly.
      WD.aborted = true;
      WD.epoch = (WD.epoch || 0) + 1;
      clearResolveWaiters();
    }
    const runId = ++activeRunId;
    beginRun(runSeq, msg.options || {});
    running = true;
    try {
      if (WD.aa) {
        WD.aa("WD_RUN start", {
          runSeq,
          step: WD.engine.detectStep(),
          newAttempt: !!(msg.options && msg.options.newAttempt),
          onlyInvalid: msg.options && msg.options.onlyInvalid
            ? (msg.options.onlyInvalid.length || 0)
            : 0,
          build: BUILD,
        });
      }
    } catch {}

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
        // Superseded by a newer WD_RUN — do not resolve the panel waiter.
        if (runId !== activeRunId) return;
        send({
          type: "WD_DONE",
          reports,
          aborted: !!(WD.isAborted && WD.isAborted()),
          runSeq,
        });
      } catch (e) {
        if (runId !== activeRunId) return;
        if (e && e.name === "WDAborted") {
          send({ type: "WD_DONE", reports, aborted: true, runSeq });
        } else {
          send({ type: "WD_ERROR", error: String((e && e.message) || e), reports, runSeq });
        }
      } finally {
        if (runId === activeRunId) running = false;
      }
    })();
  });

  try {
    WD.log("engine ready", location.href);
    WD.log("wd-content build:", BUILD);
  } catch {}
})();
