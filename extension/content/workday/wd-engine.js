// Workday engine — step detection + run orchestration.
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

  function detectStep() {
    if (D.exists(S.AID("applyFlowMyInfoPage")) || D.headingHas("My Information")) return "myInfo";
    if (D.exists(S.AID("applyFlowMyExpPage")) || D.exists(S.AID("applyFlowMyExperiencePage")) || D.headingHas("My Experience"))
      return "experience";
    // Self Identify (CC-305 disability) is a SEPARATE page from Voluntary
    // Disclosures, but Workday often presents them back-to-back. They MUST have
    // distinct step ids — the auto-advance loop detects "did we move?" by step-id
    // change, so sharing an id makes it think Voluntary→SelfId never happened and
    // skip a dedicated fill pass on Self Identify (leaving Name/Date/box empty).
    if (D.headingHas("Self Identify") || D.headingHas("Self-Identify")) return "selfid";
    if (D.headingHas("Voluntary Disclosure")) return "voluntary";
    if (D.headingHas("Application Question")) return "questions";
    if (D.headingHas("Review") || D.exists(S.AID("applyFlowReviewPage"))) return "review";
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
      if (!clean) {
        console.warn(
          "[workday] detectValidation:",
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

  async function fillCurrent(profile, options) {
    const step = detectStep();
    const rep = { step: step || "unknown", filled: [], missed: [], unmatched: [] };
    // The generic formField pass handles My Information, Voluntary Disclosures,
    // Application Questions, and any other flat Workday step.
    await S.fillStep(profile, options || {}, rep);
    if (step === "experience") await S.fillExperienceExtras(profile, options || {}, rep);
    return rep;
  }

  async function clickNext() {
    const cands = [
      S.AID("pageFooterNextButton"),
      S.AID("bottom-navigation-next-button"),
      S.AID("btnNext"),
      S.AID("wizardNextButton"),
    ];
    for (const s of cands) {
      if (D.exists(s) && (await D.click(s))) return true;
    }
    return await D.click("//button[contains(.,'Save and Continue') or normalize-space()='Next' or normalize-space()='Continue']");
  }

  async function runAll(profile, options, onReport) {
    options = options || {};
    let guard = 0;
    for (;;) {
      const step = detectStep();
      if (!step || step === "review") break;
      const rep = await fillCurrent(profile, options);
      if (onReport) onReport(rep);
      if (!options.autoAdvance) break;
      const ok = await clickNext();
      if (!ok) break;
      await D.delay(1500);
      if (detectStep() === step) break; // validation blocked / stuck — stop safely
      if (++guard > 8) break;
    }
  }

  WD.engine = { detectStep, detectValidation, fillCurrent, clickNext, runAll };
})();
