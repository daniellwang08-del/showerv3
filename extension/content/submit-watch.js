// Detects when the user successfully submits a job application on the live page,
// then notifies the NAO side panel so it can Complete & Next automatically.
// Injected into all frames while an application session is open.
//
// Safety: we do NOT fire on Continue/Next, and we do NOT assume success from a
// Submit click alone. After a final Submit we wait for a thank-you/confirmation
// signal, a navigation away from the form, or the Submit control/form
// disappearing with no validation errors or captcha challenge on screen.

(function () {
  if (window.__NAO_SUBMIT_WATCH__) return;
  window.__NAO_SUBMIT_WATCH__ = true;

  let lastNotifyAt = 0;
  let pendingTimer = null;
  let armedClick = false;

  function textOf(el) {
    if (!el) return "";
    return String(
      el.innerText ||
        el.textContent ||
        el.value ||
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function attrsOf(el) {
    if (!el || !el.getAttribute) return "";
    return [
      el.id,
      el.name,
      el.className && String(el.className),
      el.getAttribute("data-test"),
      el.getAttribute("data-testid"),
      el.getAttribute("data-automation-id"),
      el.getAttribute("data-qa"),
      el.getAttribute("data-provides"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function isNavigationOnly(text) {
    if (!text) return false;
    if (/save\s*(&|and)\s*continue/.test(text)) return true;
    if (/^(next|continue|back|previous|cancel|close|save|edit|upload|add|remove|delete)$/.test(text)) {
      return true;
    }
    if (/^next\b/.test(text) && !/\bsubmit\b/.test(text)) return true;
    if (/\bcontinue\b/.test(text) && !/\bsubmit\b/.test(text)) return true;
    return false;
  }

  function looksLikeFinalSubmitText(text) {
    if (!text || isNavigationOnly(text)) return false;
    // Avoid listing-page CTAs like "Apply" / "Apply now" - those open the form.
    if (/^(apply|apply now|easy apply)$/.test(text)) return false;
    if (/^submit$/.test(text)) return true;
    if (/\bsubmit(\s+my)?\s+application\b/.test(text)) return true;
    if (/\bsubmit\s+application\b/.test(text)) return true;
    if (/\bsend\s+(my\s+)?application\b/.test(text)) return true;
    if (/\bcomplete\s+application\b/.test(text)) return true;
    if (/\bsubmit\b/.test(text) && !/\bcontinue\b/.test(text) && !/\bnext\b/.test(text)) {
      return true;
    }
    return false;
  }

  function looksLikeFinalSubmit(el) {
    if (!el || el.disabled) return false;
    const tag = (el.tagName || "").toUpperCase();
    const type = String(el.getAttribute("type") || el.type || "").toLowerCase();
    const text = textOf(el);
    const attrs = attrsOf(el);

    if (isNavigationOnly(text)) return false;
    if (/footer-next|btn-next|saveandcontinue|save-and-continue|continuebutton/.test(attrs)) {
      return false;
    }
    if (
      /footer-submit|submitapplication|submit-application|btn-submit|application-submit|submitbutton/.test(
        attrs
      )
    ) {
      return true;
    }
    if ((tag === "INPUT" || tag === "BUTTON") && type === "submit") {
      return looksLikeFinalSubmitText(text || "submit");
    }
    if (tag !== "BUTTON" && tag !== "INPUT" && tag !== "A" && el.getAttribute("role") !== "button") {
      if (!/button|submit|btn/.test(attrs)) return false;
    }
    return looksLikeFinalSubmitText(text);
  }

  function closestSubmitControl(node) {
    let el = node;
    for (let i = 0; el && i < 6; i++) {
      if (looksLikeFinalSubmit(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // iCIMS applications span several server-rendered steps ("Step 2 of 4"), each
  // ending in an identically labelled "Submit" and each a full page load. The
  // header lists the whole itinerary, so a page whose current step is not the
  // last one is provably mid-application - it must never be read as a
  // confirmation, or the side panel marks the job applied and moves on while
  // steps are still unfilled.
  function icimsMidApplication() {
    try {
      const root = document.querySelector(".iCIMS_Steps");
      if (!root) return false;
      const items = Array.from(root.querySelectorAll("li"));
      if (!items.length) return false;
      // "iCIMS_Steps_NotCurrent" contains "Current", so this must be an exact
      // class-token test, never a substring or regex match on className.
      const idx = items.findIndex((li) => li.classList && li.classList.contains("iCIMS_Steps_Current"));
      if (idx < 0) return false;
      return idx + 1 < items.length;
    } catch {
      return false;
    }
  }

  function looksLikeConfirmationPage() {
    if (icimsMidApplication()) return false;
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
        document.querySelector(
          [
            ".application--confirmation",
            ".application-confirmation",
            "[data-provides='application-confirmation']",
            "[data-automation-id='applicationSubmitted']",
            "[data-automation-id='submittedPage']",
            "[data-automation-id='thankYouMessage']",
            "[data-automation-id='applicationComplete']",
            "#application_confirmation",
          ].join(",")
        )
      ) {
        return true;
      }
      const body = String((document.body && document.body.innerText) || "")
        .slice(0, 5000)
        .toLowerCase();
      if (
        /thank you for (applying|your application)|application (has been |was )?submitted|we('ve| have) received your application|successfully applied|your application is on its way|you('ve| have) successfully submitted|you('ve| have) applied|good luck/i.test(
          body
        )
      ) {
        return true;
      }
      // JobDiva Quick Apply success screen.
      try {
        if (
          document.querySelector(".container-fluid") &&
          /you('ve| have) applied/i.test(body) &&
          /return to open jobs/i.test(body)
        ) {
          return true;
        }
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  function stillOnApplicationForm() {
    try {
      // Confirmation pages win over leftover form chrome.
      if (looksLikeConfirmationPage()) return false;
      if (icimsMidApplication()) return true;
      const nextBtn = document.querySelector(
        'button[data-automation-id="bottom-navigation-next-button"], button[data-automation-id="pageFooterNextButton"]'
      );
      // Workday Review/Submit still has the footer button, that is still "on form".
      // After submit the footer usually disappears; don't treat progress-only chrome
      // as an active application form.
      const hasWorkdayFields = !!document.querySelector('[data-automation-id^="formField-"]');
      const hasWorkdayApplyFlow = !!document.querySelector(
        '[data-automation-id="applyFlowMyInfoPage"], [data-automation-id="applyFlowReviewPage"], [data-automation-id="applyFlowMyExpPage"]'
      );
      if (nextBtn && (hasWorkdayFields || hasWorkdayApplyFlow)) return true;
      return !!document.querySelector(
        [
          'form input[type="file"]',
          "form#application-form",
          "#application_form",
          "form#form_submit_new_resume",
          "[data-qa='btn-submit']",
          "oc-button[data-test='footer-submit']",
          ".application--form",
          "#main_fields",
          // iCIMS renders each step's fields as a div "table".
          ".iCIMS_ProfileFormTable",
        ].join(",")
      );
    } catch {
      return true;
    }
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch {
      return false;
    }
  }

  // Inline validation that means the submit was rejected and the user must fix fields.
  function hasVisibleValidationErrors() {
    try {
      const invalid = document.querySelectorAll('[aria-invalid="true"]');
      for (const el of invalid) if (isVisible(el)) return true;
      const messages = document.querySelectorAll(
        [
          ".field-error",
          ".error-message",
          ".invalid-feedback",
          ".has-error .help-block",
          ".application--error",
          "[data-automation-id='errorMessage']",
          "[data-automation-id='inputAlert']",
          "[role='alert']",
        ].join(",")
      );
      for (const el of messages) {
        if (isVisible(el) && textOf(el)) return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  // A challenge on screen means the submit is still waiting on the user.
  function hasVisibleCaptchaChallenge() {
    try {
      const frames = document.querySelectorAll(
        'iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"], iframe[src*="hcaptcha.com"][title*="challenge" i], iframe[src*="challenges.cloudflare.com"]'
      );
      for (const f of frames) {
        if (!isVisible(f)) continue;
        const r = f.getBoundingClientRect();
        if (r.width > 100 && r.height > 100) return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  // No confirmation text, but the final Submit went through: the control (or
  // its form) disappeared or the page moved on, with no errors or challenge.
  function probablySubmitted(ctl, startUrl) {
    if (icimsMidApplication() || hasVisibleValidationErrors() || hasVisibleCaptchaChallenge()) return false;
    const controlGone = ctl ? !isVisible(ctl) : false;
    const formGone = ctl && ctl.form ? !ctl.form.isConnected || !isVisible(ctl.form) : false;
    return controlGone || formGone || location.href !== startUrl;
  }

  function notifySubmitted(reason) {
    const now = Date.now();
    if (now - lastNotifyAt < 5000) return;
    lastNotifyAt = now;
    armedClick = false;
    if (pendingTimer) {
      clearInterval(pendingTimer);
      pendingTimer = null;
    }
    try {
      chrome.runtime.sendMessage({
        type: "APP_SUBMITTED",
        reason: reason || "submit",
        url: location.href,
        at: now,
      });
    } catch {
      /* extension context invalidated */
    }
  }

  // Poll every 500ms for up to 20s. Probable-submit signals must hold for two
  // consecutive polls after the first 2s so a spinner swap or a slow
  // validation pass is not mistaken for success.
  const POLL_MS = 500;
  const MAX_TRIES = 40;
  const PROBABLE_AFTER_TRIES = 4;

  function armPendingSubmit(reason, ctl) {
    armedClick = true;
    const startUrl = location.href;
    if (pendingTimer) clearInterval(pendingTimer);
    let tries = 0;
    let probableStreak = 0;
    pendingTimer = setInterval(() => {
      tries += 1;
      if (looksLikeConfirmationPage()) {
        notifySubmitted(reason + "+confirm");
        return;
      }
      // Navigated away from the form (common after successful submit).
      if (location.href !== startUrl && !stillOnApplicationForm()) {
        notifySubmitted(reason + "+navigated");
        return;
      }
      if (tries >= PROBABLE_AFTER_TRIES && probablySubmitted(ctl, startUrl)) {
        probableStreak += 1;
        if (probableStreak >= 2) {
          notifySubmitted(reason + "+probable");
          return;
        }
      } else {
        probableStreak = 0;
      }
      if (tries >= MAX_TRIES) {
        // No success signal: likely a validation error or a stalled submit.
        clearInterval(pendingTimer);
        pendingTimer = null;
        armedClick = false;
      }
    }, POLL_MS);
  }

  function blockedByNativeValidation(ctl) {
    try {
      const form = ctl && ctl.form;
      return !!form && !form.noValidate && typeof form.checkValidity === "function" && !form.checkValidity();
    } catch {
      return false;
    }
  }

  document.addEventListener(
    "click",
    (e) => {
      const ctl = closestSubmitControl(e.target);
      if (!ctl || blockedByNativeValidation(ctl)) return;
      armPendingSubmit("click", ctl);
    },
    true
  );

  document.addEventListener(
    "submit",
    (e) => {
      const form = e.target;
      if (!form || form.tagName !== "FORM") return;
      const submitter = e.submitter || document.activeElement;
      if (submitter && isNavigationOnly(textOf(submitter))) return;
      if (submitter && looksLikeFinalSubmit(submitter)) {
        armPendingSubmit("form-submit", submitter);
      }
    },
    true
  );

  function checkConfirmation() {
    if (looksLikeConfirmationPage()) {
      notifySubmitted(armedClick ? "confirm-after-click" : "confirm-page");
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(checkConfirmation, 500));
  } else {
    setTimeout(checkConfirmation, 600);
  }
})();
