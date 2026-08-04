// JobDiva (*.jobdiva.com) Quick Apply helpers.
//
// Flow: job page → Apply Now → "How would you like to apply?" modal →
// Quick Apply (No Account) → "My Application" modal (.job-app-main) with
// native React text/file/checkbox controls (.jd-form-layout / .jd-label).
// Reuses the greenhouse select/LLM bundle; this module owns opening Quick
// Apply, label/required resolution, skipping the phone country flag, SMS
// consent, and Submit Application.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean } = AF.dom;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function btnText(el) {
    return clean((el && (el.innerText || el.textContent)) || "");
  }

  function findButtonByText(re, root) {
    const scope = root || document;
    let nodes = [];
    try {
      nodes = scope.querySelectorAll("button, a[role='button'], [role='button']");
    } catch {
      return null;
    }
    for (const el of nodes) {
      if (!el || el.disabled) continue;
      if (re.test(btnText(el))) return el;
    }
    return null;
  }

  function isJobDivaHost() {
    try {
      const h = location.hostname || "";
      return /(^|\.)jobdiva\.com$/i.test(h);
    } catch {
      return false;
    }
  }

  function applicationRoot() {
    try {
      return (
        document.querySelector(".modal-content:has(.job-app-main)") ||
        document.querySelector(".job-app-main") ||
        document.querySelector(".modal-content:has(.job-app-title-1)") ||
        null
      );
    } catch {
      return document.querySelector(".job-app-main") || null;
    }
  }

  function hasApplicationForm() {
    return !!applicationRoot();
  }

  function hasApplyNow() {
    return !!findButtonByText(/^apply now$/i);
  }

  function hasMethodModal() {
    try {
      const body = document.querySelector(".modal-content .modal-body, .modal-body");
      if (!body) return false;
      const t = clean(body.innerText || "");
      return /how would you like to apply/i.test(t) || /quick apply\s*\(no account\)/i.test(t);
    } catch {
      return false;
    }
  }

  function isJobDivaPage() {
    try {
      if (isJobDivaHost()) return true;
      // White-label shells that still ship JobDiva widgets.
      return !!(hasApplicationForm() || (hasApplyNow() && document.querySelector("button.jd-btn, .jd-btn")));
    } catch {
      return false;
    }
  }

  function stripLabel(s) {
    return clean(s)
      .replace(/\s*\*\s*$/g, "")
      .replace(/:\s*$/g, "")
      .trim();
  }

  function formLayout(el) {
    return (el && el.closest && el.closest(".jd-form-layout, .job-app-text-field, .jd-dropzone")) || null;
  }

  function questionTitleFor(el) {
    if (!el || !isJobDivaPage()) return "";
    try {
      const t = (el.type || "").toLowerCase();
      if (t === "checkbox" || t === "radio") {
        const wrap = el.closest("label") || el.parentElement;
        if (wrap) {
          const txt = clean(wrap.innerText || wrap.textContent || "");
          if (txt) return txt.slice(0, 200);
        }
        return "";
      }
      if (t === "file") {
        const dz = el.closest && el.closest(".jd-dropzone, .job-app-main");
        if (dz) {
          const layout = el.closest(".jd-form-layout") || (dz.closest && dz.closest(".jd-form-layout"));
          const lab =
            (layout && layout.querySelector(".jd-label")) || dz.querySelector(".jd-label");
          if (lab && clean(lab.textContent)) return stripLabel(lab.textContent).slice(0, 200);
        }
        // Dropzone chrome often only says Resume nearby.
        const near = el.closest(".job-app-main, .modal-content");
        if (near) {
          const labs = near.querySelectorAll(".jd-label");
          for (const lab of labs) {
            const s = stripLabel(lab.textContent || "");
            if (/resume|cv|cover/i.test(s)) return s.slice(0, 200);
          }
        }
        return "Resume";
      }
      const layout = formLayout(el);
      if (layout) {
        const lab = layout.querySelector(".jd-label, label.jd-label, label");
        if (lab && clean(lab.textContent)) return stripLabel(lab.textContent).slice(0, 200);
      }
      // Phone number sits beside the flag dropdown; label is on the outer layout.
      const phoneWrap = el.closest && el.closest(".jd-form-phone, .d-flex.gap-12");
      if (phoneWrap) {
        const outer = phoneWrap.closest(".jd-form-layout, .job-app-text-field");
        const lab = outer && outer.querySelector(".jd-label, label");
        if (lab && clean(lab.textContent)) return stripLabel(lab.textContent).slice(0, 200);
      }
    } catch {}
    return "";
  }

  function isRequiredControl(el) {
    if (!el || !isJobDivaPage()) return false;
    try {
      if (el.required || (el.getAttribute && el.getAttribute("aria-required") === "true")) return true;
      const t = (el.type || "").toLowerCase();
      if (t === "file") {
        const title = questionTitleFor(el);
        if (/resume|cv/i.test(title)) return true;
      }
      const layout = formLayout(el) || (el.closest && el.closest(".job-app-text-field"));
      if (!layout) return false;
      const lab = layout.querySelector(".jd-label, label");
      if (lab && (lab.querySelector(".jd-text-red") || /\*/.test(lab.textContent || ""))) return true;
    } catch {}
    return false;
  }

  // Skip the phone country flag dropdown button — leave default US; fill the
  // adjacent phone text input only.
  function shouldSkipControl(el) {
    if (!el || !isJobDivaPage()) return false;
    try {
      if (el.closest && el.closest(".jd-form-phone")) {
        const tag = (el.tagName || "").toUpperCase();
        if (tag === "BUTTON") return true;
        if (el.getAttribute && el.getAttribute("data-bs-toggle") === "dropdown") return true;
      }
      // Apply / Cancel / Submit chrome inside the modal footer — not fields.
      if (el.matches && el.matches("button.jd-btn, button.jd-btn-mobile, button.jd-btn-outline")) {
        const t = btnText(el);
        if (/apply now|quick apply|sign into|create an account|cancel|submit application/i.test(t)) {
          return true;
        }
      }
    } catch {}
    return false;
  }

  function consentCheckboxes() {
    const out = [];
    const seen = new Set();
    const add = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };
    try {
      const root = applicationRoot() || document;
      root.querySelectorAll('input[type="checkbox"]').forEach((el) => {
        const wrap = el.closest("label") || el.parentElement;
        const txt = clean((wrap && wrap.innerText) || "");
        if (/sms|text message|marketing|consent|agree|notify|phone/i.test(txt)) add(el);
      });
    } catch {}
    return out;
  }

  function tickSmsConsent() {
    if (!isJobDivaPage()) return 0;
    let n = 0;
    for (const cb of consentCheckboxes()) {
      if (cb.checked) continue;
      try {
        cb.click();
      } catch {
        try {
          cb.checked = true;
          cb.dispatchEvent(new Event("input", { bubbles: true }));
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        } catch {}
      }
      if (cb.checked) n++;
    }
    return n;
  }

  function applyNowButton() {
    return findButtonByText(/^apply now$/i);
  }

  function quickApplyButton() {
    return (
      findButtonByText(/quick apply\s*\(no account\)/i) ||
      findButtonByText(/^quick apply/i)
    );
  }

  // Sync kick used by findAutoContainer: click Apply Now / Quick Apply if the
  // form is not mounted yet. Full wait lives in openQuickApply (AF_JD_PREP).
  function ensureJobDivaFormVisible() {
    try {
      if (!isJobDivaPage()) return;
      if (hasApplicationForm()) return;
      const qa = quickApplyButton();
      if (qa) {
        qa.click();
        return;
      }
      const apply = applyNowButton();
      if (apply) apply.click();
    } catch {}
  }

  async function waitFor(pred, budgetMs, stepMs) {
    const budget = budgetMs == null ? 14000 : budgetMs;
    const step = stepMs == null ? 200 : stepMs;
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await sleep(step);
    }
    return !!pred();
  }

  // Idempotent: open My Application via Apply Now → Quick Apply (No Account).
  async function openQuickApply() {
    if (!isJobDivaPage() && !hasApplyNow() && !hasApplicationForm()) {
      return { ready: false, reason: "not-jobdiva" };
    }
    if (hasApplicationForm()) {
      return { ready: true, already: true };
    }

    if (!hasMethodModal()) {
      const apply = applyNowButton();
      if (apply) {
        try {
          apply.click();
        } catch {}
      }
      const opened = await waitFor(() => hasMethodModal() || hasApplicationForm(), 8000);
      if (!opened && !hasApplicationForm()) {
        return { ready: false, reason: "no-method-modal" };
      }
    }

    if (hasApplicationForm()) {
      return { ready: true };
    }

    const qa = quickApplyButton();
    if (!qa) return { ready: false, reason: "no-quick-apply" };
    try {
      qa.click();
    } catch {}

    const ready = await waitFor(() => hasApplicationForm(), 14000);
    return { ready: !!ready, reason: ready ? undefined : "form-timeout" };
  }

  function submitButton() {
    const root = applicationRoot() || document;
    return (
      findButtonByText(/^submit application$/i, root) ||
      findButtonByText(/\bsubmit application\b/i, root) ||
      root.querySelector("button.jd-btn-mobile") ||
      null
    );
  }

  function clickSubmit() {
    const btn = submitButton();
    if (!btn || btn.disabled) return false;
    try {
      btn.click();
      return true;
    } catch {
      return false;
    }
  }

  // JobDiva success screen after Quick Apply POST (DOM provided by candidate):
  //   <div class="container-fluid…"><span>You've applied! Good luck!</span>
  //   <button class="btn jd-btn-outline">Return to Open Jobs</button></div>
  // The Quick Apply modal may still sit in the DOM (display:none) with
  // .job-app-main, so we must NOT require hasApplicationForm() === false.
  function hasAppliedSuccess() {
    try {
      if (findButtonByText(/^return to open jobs$/i)) return true;
      const nodes = document.querySelectorAll(
        ".container-fluid span, .container-fluid .font-weight-bold, .text-center.font-weight-bold, .col-12.text-center"
      );
      for (const n of nodes) {
        const t = clean(n.innerText || n.textContent || "");
        if (/you('ve| have) applied/i.test(t)) return true;
      }
      const body = clean((document.body && document.body.innerText) || "").slice(0, 6000);
      if (/you('ve| have) applied/i.test(body)) return true;
      if (/good luck/i.test(body) && /return to open jobs/i.test(body)) return true;
    } catch {}
    return false;
  }

  // After a Submit click: success screen, or modal gone (and not back on the
  // method chooser) counts as success.
  function looksSubmittedAfterClick(hadForm) {
    if (looksSubmitted()) return true;
    if (!hadForm) return false;
    try {
      if (!hasApplicationForm() && !hasMethodModal()) return true;
      // Visible application modal dismissed while success chrome is up.
      const modal = document.querySelector("#quickApplyModal");
      if (modal) {
        const hidden =
          modal.getAttribute("aria-hidden") === "true" ||
          getComputedStyle(modal).display === "none" ||
          !modal.classList.contains("show");
        if (hidden && hasAppliedSuccess()) return true;
      }
    } catch {}
    return false;
  }

  function validationErrors() {
    const out = [];
    try {
      if (hasAppliedSuccess()) return out;
      const root = applicationRoot() || document;
      root.querySelectorAll(".invalid-feedback, .jd-text-red, [class*='error'], .text-danger").forEach((n) => {
        const t = clean(n.innerText || n.textContent || "");
        if (!t || t === "*") return;
        if (/required|invalid|please|must|missing|upload/i.test(t)) out.push(t.slice(0, 160));
      });
    } catch {}
    return [...new Set(out)].slice(0, 8);
  }

  function looksSubmitted() {
    try {
      if (hasAppliedSuccess()) return true;
      if (!hasApplicationForm()) {
        // Method modal alone after a failed submit is not success.
        if (hasMethodModal()) return false;
        const body = clean((document.body && document.body.innerText) || "").slice(0, 4000);
        if (
          /thank you|application (has been |was )?submitted|we('ve| have) received|successfully applied|application (is )?on its way/i.test(
            body
          )
        ) {
          return true;
        }
        // Form closed without the method modal — treat as submitted.
        if (!hasApplyNow() || /submitted|thank you/i.test(body)) return true;
      }
      const root = applicationRoot();
      if (root) {
        const t = clean(root.innerText || "").slice(0, 2000);
        if (/thank you|application submitted|successfully applied|we('ve| have) received|you('ve| have) applied/i.test(t)) {
          return true;
        }
      }
    } catch {}
    return false;
  }

  function submitState() {
    const errors = validationErrors();
    const submitted = looksSubmitted();
    const btn = submitButton();
    return {
      submitted,
      stillOnForm: !submitted && hasApplicationForm() && !hasAppliedSuccess(),
      hasSubmit: !!btn,
      submitDisabled: !!(btn && btn.disabled),
      errors,
    };
  }

  // Poll after Submit for the success screen or validation errors. JobDiva's
  // quickapplyjob POST often takes several seconds before "You've applied!".
  async function waitAfterSubmit(budgetMs) {
    const hadForm = hasApplicationForm();
    const budget = budgetMs == null ? 20000 : budgetMs;
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      if (hasAppliedSuccess() || looksSubmittedAfterClick(hadForm)) {
        const st = submitState();
        return { ...st, submitted: true, stillOnForm: false };
      }
      const st = submitState();
      if (st.errors && st.errors.length && st.stillOnForm) return st;
      await sleep(250);
    }
    const st = submitState();
    if (hasAppliedSuccess() || looksSubmittedAfterClick(hadForm)) {
      return { ...st, submitted: true, stillOnForm: false };
    }
    return st;
  }

  AF.jobdiva = {
    isJobDivaHost,
    isJobDivaPage,
    applicationRoot,
    hasApplicationForm,
    hasAppliedSuccess,
    questionTitleFor,
    isRequiredControl,
    shouldSkipControl,
    tickSmsConsent,
    consentCheckboxes,
    ensureJobDivaFormVisible,
    openQuickApply,
    applyNowButton,
    quickApplyButton,
    submitButton,
    clickSubmit,
    submitState,
    waitAfterSubmit,
  };
})();
