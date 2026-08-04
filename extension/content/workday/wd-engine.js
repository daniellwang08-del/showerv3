// Workday engine - step detection + run orchestration.
//
// Workday is a single-page app: the same frame swaps between application steps.
// detectStep() inspects headings + key automation-ids to classify the current
// step, fillCurrent() runs the matching section filler, and runAll() optionally
// auto-advances (clicking Save and Continue / Next) until it reaches Review.
// Auto-submit is intentionally never performed. Namespaced under window.__WD.engine.
(() => {
  // Always (re)install so an updated extension takes effect on the next Start
  // without a manual page reload. engine is a pure namespace re-derived from the
  // (also-reinstalled) steps/dom; it owns no persistent listeners or state.
  const WD = (window.__WD = window.__WD || {});
  const D = WD.dom;
  const S = WD.steps;

  function detectSubmittedPage() {
    try {
      const url = String(location.href || "").toLowerCase();
      if (
        /thank[-_\s]?you|application[-_\s]?submitted|application[-_\s]?received|confirmation|\/thanks\b|\/applied\b/.test(
          url
        )
      ) {
        return true;
      }
      if (
        D.exists(S.AID("applicationSubmitted")) ||
        D.exists(S.AID("submittedPage")) ||
        D.exists(S.AID("thankYouMessage")) ||
        D.exists('[data-automation-id="applicationSubmitted"]') ||
        D.exists('[data-automation-id="submittedPage"]') ||
        D.exists('[data-automation-id="thankYouMessage"]')
      ) {
        return true;
      }
      const title = D.pageHeadingHas
        ? D.pageHeadingHas("Thank You") ||
          D.pageHeadingHas("Application Submitted") ||
          D.pageHeadingHas("You've Submitted") ||
          D.pageHeadingHas("You Have Submitted")
        : false;
      if (title) return true;
      const body = String((document.body && document.body.innerText) || "")
        .slice(0, 5000)
        .toLowerCase();
      if (
        /thank you for (applying|your application)|application (has been |was )?submitted|we('ve| have) received your application|successfully applied|your application is on its way|you('ve| have) successfully submitted/.test(
          body
        )
      ) {
        // Avoid matching review copy that mentions submitting later.
        if (/\breview\b/.test(body) && /\bsubmit\b/.test(body) && /save and continue|application questions|my information/.test(body)) {
          return false;
        }
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  function pageHeadingHas(text) {
    if (D.pageHeadingHas) return D.pageHeadingHas(text);
    return D.headingHas(text);
  }

  function isFinalSubmitControl(el) {
    if (!el) return false;
    const text = D.norm(el.innerText || el.textContent || el.getAttribute("aria-label") || "");
    if (!text) return false;
    // Auto-advance must never click final Submit — that is the user's action
    // (or submit-watch → Complete & Next). Mis-detecting Review as My Info used
    // to click this same footer control and then get stuck.
    if (/^submit$/.test(text)) return true;
    if (/\bsubmit(\s+my)?\s+application\b/.test(text)) return true;
    if (/\bsubmit\s+application\b/.test(text)) return true;
    if (/\bsubmit\b/.test(text) && !/\bsave\b/.test(text) && !/\bcontinue\b/.test(text)) return true;
    return false;
  }

  function footerLooksLikeSubmit() {
    for (const s of [
      S.AID("pageFooterNextButton"),
      S.AID("bottom-navigation-next-button"),
      S.AID("btnNext"),
      S.AID("wizardNextButton"),
    ]) {
      const el = D.q(s);
      if (el && D.isVisible(el) && isFinalSubmitControl(el)) return true;
    }
    return false;
  }

  function detectStep() {
    // Post-submit confirmation must win — leftover progress labels still say
    // "My Information" and used to send auto-advance into a dead end.
    if (detectSubmittedPage()) return "submitted";

    // Review before My Information: the progress rail often keeps earlier step
    // names visible as headings. A footer labeled Submit is also Review.
    if (
      D.exists(S.AID("applyFlowReviewPage")) ||
      pageHeadingHas("Review") ||
      footerLooksLikeSubmit()
    ) {
      return "review";
    }

    // Self Identify (CC-305 disability) is a SEPARATE page from Voluntary
    // Disclosures, but Workday often presents them back-to-back. They MUST have
    // distinct step ids - the auto-advance loop detects "did we move?" by step-id
    // change, so sharing an id makes it think Voluntary→SelfId never happened and
    // skip a dedicated fill pass on Self Identify (leaving Name/Date/box empty).
    if (pageHeadingHas("Self Identify") || pageHeadingHas("Self-Identify")) return "selfid";
    if (pageHeadingHas("Voluntary Disclosure")) return "voluntary";
    if (pageHeadingHas("Application Question")) return "questions";
    if (
      D.exists(S.AID("applyFlowMyExpPage")) ||
      D.exists(S.AID("applyFlowMyExperiencePage")) ||
      pageHeadingHas("My Experience")
    ) {
      return "experience";
    }
    if (D.exists(S.AID("applyFlowMyInfoPage")) || pageHeadingHas("My Information")) return "myInfo";
    // Fallback: any page that exposes Workday formField wrappers is fillable.
    if (D.exists('[data-automation-id^="formField-"]')) return "generic";
    return null;
  }

  // Inspect the current step for Workday validation errors AFTER a commit/flush.
  // Two independent signals: (1) any visible control flagged aria-invalid="true",
  // mapped back to its formField wrapper + label; (2) a visible error summary /
  // alert region (e.g. the "Errors Found" box). Returns { clean, invalidFields,
  // errorCount } so the orchestrator can decide whether to run an LLM recovery
  // pass before clicking "Save and Continue".
  function detectValidation() {
    const invalidFields = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('[aria-invalid="true"]')) {
      if (!D.isVisible(el)) continue;
      const ff = el.closest('[data-automation-id^="formField-"]');
      const key = ff ? ff.getAttribute("data-automation-id") : null;
      const dedupe = key || el;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      invalidFields.push({
        key: key ? key.replace(/^formField-/, "") : null,
        label: ff && S.fieldLabel ? S.fieldLabel(ff) : el.getAttribute("aria-label") || "",
      });
    }
    // Error summary / alert region. Match by role or an error-ish automation-id,
    // and only count it as an error when it actually reads like one.
    const alerts = [...document.querySelectorAll('[role="alert"], [data-automation-id*="error" i], [data-automation-id="errorMessage"]')]
      .filter((n) => D.isVisible(n) && /\b(error|required|must|invalid)\b/i.test(n.textContent || ""));
    const clean = invalidFields.length === 0 && alerts.length === 0;
    try {
      if (!clean && WD.log) {
        WD.log(
          "detectValidation:",
          invalidFields.length,
          "invalid field(s),",
          alerts.length,
          "alert(s) ->",
          invalidFields.map((f) => f.label || f.key),
          alerts.map((a) => (a.textContent || "").trim().slice(0, 60))
        );
      }
    } catch {}
    return { clean, invalidFields, errorCount: invalidFields.length || alerts.length };
  }

  function aborted() {
    return !!(WD.isAborted && WD.isAborted());
  }

  async function fillCurrent(profile, options) {
    if (aborted()) {
      const err = new Error("WD_ABORTED");
      err.name = "WDAborted";
      throw err;
    }
    const step = detectStep();
    const rep = { step: step || "unknown", filled: [], missed: [], unmatched: [] };
    // The generic formField pass handles My Information, Voluntary Disclosures,
    // Application Questions, and any other flat Workday step.
    await S.fillStep(profile, options || {}, rep);
    if (aborted()) return rep;
    // fillStep intentionally skips the Work Experience / Education panel fields
    // (see inExperiencePanel), so fillExperienceExtras is the ONLY thing that fills
    // them — including on onlyInvalid recovery passes (a still-empty School must be
    // retried through the correct search-prompt path, never the generic one).
    // fillExperienceExtras is idempotent and recovery-light (it skips the resume
    // upload / panel-add / degree-LLM work when onlyInvalid is set).
    if (step === "experience") {
      await S.fillExperienceExtras(profile, options || {}, rep);
    }
    return rep;
  }

  async function clickNext() {
    if (aborted()) return false;
    const cands = [
      S.AID("pageFooterNextButton"),
      S.AID("bottom-navigation-next-button"),
      S.AID("btnNext"),
      S.AID("wizardNextButton"),
    ];
    for (const s of cands) {
      const el = D.q(s);
      if (!el || !D.isVisible(el) || isFinalSubmitControl(el)) continue;
      D.clickEl(el);
      return true;
    }
    return await D.click(
      "//button[contains(.,'Save and Continue') or normalize-space()='Next' or normalize-space()='Continue']"
    );
  }

  async function runAll(profile, options, onReport) {
    options = options || {};
    let guard = 0;
    for (;;) {
      if (aborted()) break;
      const step = detectStep();
      if (!step || step === "review" || step === "submitted") break;
      const rep = await fillCurrent(profile, options);
      if (onReport) onReport(rep);
      if (!options.autoAdvance) break;
      if (aborted()) break;
      const ok = await clickNext();
      if (!ok) break;
      await D.delay(1500);
      if (detectStep() === step) break; // validation blocked / stuck - stop safely
      if (++guard > 8) break;
    }
  }

  WD.engine = {
    detectStep,
    detectSubmittedPage,
    detectValidation,
    fillCurrent,
    clickNext,
    runAll,
  };
})();

