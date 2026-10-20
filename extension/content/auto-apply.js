// Page-side helpers for unattended auto-apply. Injected into every frame with
// the autofill engine; the auto-apply runner calls window.__NAO_AA__ through
// chrome.scripting.executeScript({ allFrames: true }) and merges the per-frame
// results, so embedded ATS iframes (Greenhouse, Lever on company sites) work.
//
// Nothing here runs on its own: no listeners, no clicks until asked.

(function () {
  if (window.__NAO_AA__) return;

  function textOf(el) {
    if (!el) return "";
    return String(
      el.innerText ||
        el.textContent ||
        el.value ||
        (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) ||
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
      el.getAttribute("data-qa"),
      el.getAttribute("data-automation-id"),
      el.getAttribute("data-ui"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
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

  function isDisabled(el) {
    return !!(el.disabled || el.getAttribute("aria-disabled") === "true");
  }

  const CONTROL_SELECTOR = 'button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]';

  function controls() {
    return Array.from(document.querySelectorAll(CONTROL_SELECTOR)).filter(isVisible);
  }

  function isNavigationOnly(text) {
    if (!text) return false;
    if (/^(back|previous|cancel|close|edit|upload|add|remove|delete|save( draft)?)$/.test(text)) return true;
    if (/\b(sign in|log in|login|create account|register|apply with linkedin|apply with indeed)\b/.test(text)) return true;
    return false;
  }

  function isNextStep(text) {
    if (!text || /\bsubmit\b/.test(text)) return false;
    return /^(next|continue|save (&|and) continue|next step|review|review application|proceed)\b/.test(text);
  }

  function isFinalSubmit(el) {
    const text = textOf(el);
    const attrs = attrsOf(el);
    if (isNavigationOnly(text) || isNextStep(text)) return false;
    if (/^(apply|apply now|easy apply|apply for this job|i'm interested)$/.test(text)) return false;
    if (/footer-submit|submitapplication|submit-application|btn-submit|application-submit|submit_app|submitbutton/.test(attrs)) {
      return true;
    }
    if (/\bsubmit\b/.test(text) && !/\b(code|search|feedback)\b/.test(text)) return true;
    if (/\b(send|complete|finish) (my )?application\b/.test(text)) return true;
    const type = String(el.getAttribute("type") || el.type || "").toLowerCase();
    return type === "submit" && !text && !!el.closest("form");
  }

  function findFinalSubmit() {
    const hits = controls().filter(isFinalSubmit);
    // The real submit sits at the end of the form; earlier hits are usually
    // header shortcuts or per-section buttons.
    return hits.length ? hits[hits.length - 1] : null;
  }

  function findNextStep() {
    const hits = controls().filter((el) => isNextStep(textOf(el)));
    return hits.length ? hits[hits.length - 1] : null;
  }

  function looksConfirmed() {
    try {
      const url = String(location.href || "").toLowerCase();
      if (/thank[-_\s]?you|application[-_\s]?submitted|application[-_\s]?received|\/confirmation\b|\/thanks\b|\/applied\b|\/success\b/.test(url)) {
        return true;
      }
      if (
        document.querySelector(
          ".application--confirmation, .application-confirmation, [data-provides='application-confirmation'], #application_confirmation, [data-ui='application-submitted']"
        )
      ) {
        return true;
      }
      const body = String((document.body && document.body.innerText) || "")
        .slice(0, 6000)
        .toLowerCase();
      return /thank you for (applying|your application)|application (has been |was )?(successfully )?(submitted|received)|we('ve| have) received your application|successfully applied|your application is on its way|you('ve| have) successfully submitted|you('ve| have) applied/.test(
        body
      );
    } catch {
      return false;
    }
  }

  const OTP_HINT = /\b(otp|one[-\s]?time|verification|verify|security|confirmation|access|pass)[-_\s]?code\b|\bpasscode\b|\b(otp|pin)\b|security-input|verification-code/;

  function otpInputs() {
    const inputs = Array.from(
      document.querySelectorAll('input:not([type]), input[type="text"], input[type="tel"], input[type="number"], input[type="password"]')
    ).filter(isVisible);
    const direct = inputs.filter((el) => {
      if (String(el.getAttribute("autocomplete") || "").toLowerCase() === "one-time-code") return true;
      const label = el.labels && el.labels[0] ? textOf(el.labels[0]) : "";
      const hint = [attrsOf(el), String(el.getAttribute("placeholder") || "").toLowerCase(), String(el.getAttribute("aria-label") || "").toLowerCase(), label].join(" ");
      return OTP_HINT.test(hint);
    });
    if (direct.length) {
      // A row of one-character boxes: return the whole row in DOM order.
      if (direct.length === 1 && Number(direct[0].maxLength) === 1) {
        const parent = direct[0].parentElement && direct[0].parentElement.parentElement;
        const row = parent ? Array.from(parent.querySelectorAll("input")).filter((el) => isVisible(el) && Number(el.maxLength) === 1) : [];
        if (row.length > 1) return row;
      }
      return direct;
    }
    // Unlabelled one-character boxes under a "code" prompt.
    const singles = inputs.filter((el) => Number(el.maxLength) === 1);
    if (singles.length >= 4) {
      const body = String((document.body && document.body.innerText) || "").slice(0, 6000).toLowerCase();
      if (/\b(code|verify|verification)\b/.test(body)) return singles;
    }
    return [];
  }

  function captchaState() {
    let challenge = false;
    let widget = false;
    try {
      for (const f of document.querySelectorAll("iframe")) {
        if (!isVisible(f)) continue;
        const src = String(f.src || "");
        const r = f.getBoundingClientRect();
        if (/recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com.*challenge|challenges\.cloudflare\.com/.test(src) && r.width > 100 && r.height > 100) {
          challenge = true;
        } else if (/recaptcha\/(api2|enterprise)\/anchor|hcaptcha\.com.*checkbox|challenges\.cloudflare\.com/.test(src) && r.width > 60) {
          widget = true;
        }
      }
    } catch {
      /* ignore */
    }
    return { challenge, widget };
  }

  function validationErrors() {
    const out = [];
    try {
      const nodes = document.querySelectorAll(
        ".field-error, .error-message, .invalid-feedback, .has-error .help-block, .application--error, .error, [role='alert'], [aria-live='assertive']"
      );
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const t = textOf(el);
        if (t && t.length < 240 && !out.includes(t)) out.push(t);
        if (out.length >= 6) break;
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  function labelFor(el) {
    try {
      if (el.labels && el.labels[0]) return textOf(el.labels[0]).slice(0, 80);
      const id = el.getAttribute("aria-labelledby");
      if (id) {
        const node = document.getElementById(id.split(/\s+/)[0]);
        if (node) return textOf(node).slice(0, 80);
      }
      return String(el.getAttribute("aria-label") || el.name || el.id || el.type || "field").slice(0, 80);
    } catch {
      return "field";
    }
  }

  // Required fields still empty; submitting would only bounce back.
  function missingRequired() {
    const out = [];
    const seenGroups = new Set();
    for (const el of document.querySelectorAll("input[required], select[required], textarea[required], [aria-required='true']")) {
      if (out.length >= 8) break;
      const tag = el.tagName;
      if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") continue;
      const type = String(el.type || "").toLowerCase();
      if (type === "hidden") continue;
      if (type === "radio" || type === "checkbox") {
        if (!el.name || seenGroups.has(el.name)) continue;
        seenGroups.add(el.name);
        const group = Array.from(document.getElementsByName(el.name));
        if (!group.some((g) => g.checked) && group.some(isVisible)) out.push(labelFor(el));
        continue;
      }
      if (type === "file") {
        if (!(el.files && el.files.length)) {
          // Many ATSs keep the real file input hidden behind a dropzone that
          // shows the uploaded file name instead.
          const zone = el.closest("[class*='upload' i], [class*='dropzone' i], fieldset, .field");
          if (!zone || !/\.(pdf|docx?|txt)\b/i.test(zone.innerText || "")) out.push(labelFor(el));
        }
        continue;
      }
      if (!isVisible(el)) continue;
      if (!String(el.value || "").trim()) out.push(labelFor(el));
    }
    return out;
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function click(el) {
    try {
      el.scrollIntoView({ block: "center" });
    } catch {
      /* ignore */
    }
    el.click();
  }

  function state() {
    const submit = findFinalSubmit();
    const next = submit ? null : findNextStep();
    const otp = otpInputs();
    const captcha = captchaState();
    const formish = !!document.querySelector("form input, form textarea, form select, input[type='file']");
    return {
      url: location.href,
      top: window === window.top,
      confirmed: looksConfirmed(),
      formish,
      submit: submit ? { label: textOf(submit).slice(0, 60), disabled: isDisabled(submit) } : null,
      next: next ? { label: textOf(next).slice(0, 60), disabled: isDisabled(next) } : null,
      otp: otp.length ? { inputs: otp.length } : null,
      captcha: captcha.challenge,
      captchaWidget: captcha.widget,
      errors: validationErrors(),
      missing: formish ? missingRequired() : [],
    };
  }

  function submit() {
    const btn = findFinalSubmit();
    if (!btn || isDisabled(btn)) return { clicked: false };
    click(btn);
    return { clicked: true, label: textOf(btn).slice(0, 60) };
  }

  function next() {
    const btn = findNextStep();
    if (!btn || isDisabled(btn)) return { clicked: false };
    click(btn);
    return { clicked: true, label: textOf(btn).slice(0, 60) };
  }

  function fillOtp(code) {
    const value = String(code || "").trim();
    const inputs = otpInputs();
    if (!value || !inputs.length) return { filled: false };
    if (inputs.length > 1 && inputs.length >= value.length) {
      value.split("").forEach((ch, i) => setNativeValue(inputs[i], ch));
    } else {
      setNativeValue(inputs[0], value);
    }
    const verify = controls().find((el) => /^(verify|submit|confirm|continue|submit application|verify (code|email))\b/.test(textOf(el)) && !isDisabled(el));
    if (verify) click(verify);
    return { filled: true, clicked: !!verify };
  }

  window.__NAO_AA__ = { state, submit, next, fillOtp };
})();
