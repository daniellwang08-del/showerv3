// Jobvite (jobs.jobvite.com) application form helpers.
//
// Jobvite renders the whole application as an AngularJS app:
//   <article ng-controller="JVApply"> → <form name="scopeData.applyForm">
//   → one or more steps <div ng-form="scopeData.stepN" ng-if="showStep(N)">.
// Each field is a <div class="jv-form-field" jv-apply-field> wrapping an inner
// <div class="jv-form-field-{input|select|radio|p} JVA_{TYPE}"> with:
//   • a real <label class="jv-form-field-label" for="jv-field-XXXX"> (matches the
//     control id), required marked by <span class="jv-required-label">*</span> and
//     aria-required="true", and
//   • the control itself: native <input>/<select ng-options>/<textarea>, or a
//     radio/checkbox <fieldset class="jv-input-group"><legend>question</legend>.
//
// Because labels use a real for=, the generic component drivers already fill
// text / select / radio correctly (AngularJS ng-model commits on the input+change
// events dom.js fires). This module only owns:
//   • host/page + form detection and clean question titles (strip the "*"),
//   • required detection from the .jv-required-label marker,
//   • skip rules for controls the widget owns (paste textareas, reCAPTCHA, the
//     LinkedIn "Apply with LinkedIn" widget), and
//   • multi-step "Next" navigation (never the "Send Application" submit).
// Resume/cover-letter attachment is a custom jv-add-attachment widget handled
// separately; it is intentionally NOT filled by the generic drivers here.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, isVisible, waitUntil, setNativeValue, fireInput } = AF.dom;

  function isJobviteHost() {
    try {
      return /(^|\.)jobvite\.com$/i.test(location.hostname || "");
    } catch {
      return false;
    }
  }

  function applicationForm() {
    try {
      return (
        document.querySelector('form[name="scopeData.applyForm"]') ||
        document.querySelector(".jv-apply-form") ||
        document.querySelector('article[ng-controller="JVApply"] form') ||
        null
      );
    } catch {
      return null;
    }
  }

  function isJobvitePage() {
    try {
      if (!isJobviteHost()) return false;
      return !!(
        applicationForm() ||
        document.querySelector('[ng-controller="JVApply"], .jv-apply-form, .jv-form-field')
      );
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

  function fieldWrapper(el) {
    return (el && el.closest && el.closest(".jv-form-field")) || null;
  }

  // Question text for a control. Radios/checkboxes read the fieldset <legend>;
  // everything else reads the label[for=id]. The trailing required "*" is stripped.
  function questionTitleFor(el) {
    if (!el || !isJobvitePage()) return "";
    try {
      const t = (el.type || "").toLowerCase();
      if (t === "radio" || t === "checkbox") {
        const fs = el.closest && el.closest("fieldset.jv-input-group, fieldset");
        const lg = fs && fs.querySelector("legend");
        if (lg && clean(lg.textContent)) return stripLabel(lg.textContent).slice(0, 200);
      }
      if (el.id) {
        let lab = null;
        try {
          lab = document.querySelector(
            'label.jv-form-field-label[for="' + CSS.escape(el.id) + '"]'
          );
        } catch {
          lab = null;
        }
        if (lab && clean(lab.textContent)) return stripLabel(lab.textContent).slice(0, 200);
      }
      const wrap = fieldWrapper(el);
      if (wrap) {
        const lab = wrap.querySelector("label.jv-form-field-label") || wrap.querySelector("label");
        if (lab && clean(lab.textContent)) return stripLabel(lab.textContent).slice(0, 200);
      }
    } catch {}
    return "";
  }

  // Jobvite marks required fields with a red * (span.jv-required-label) and
  // aria-required="true" on the control.
  function isRequiredControl(el) {
    if (!el || !isJobvitePage()) return false;
    try {
      if (el.required || (el.getAttribute && el.getAttribute("aria-required") === "true")) return true;
      const wrap = fieldWrapper(el);
      if (wrap && wrap.querySelector(".jv-required-label")) return true;
    } catch {}
    return false;
  }

  // Controls the generic drivers must NOT claim on Jobvite:
  //  • the attachment widget's "Type or paste" textareas (owned by the resume /
  //    cover-letter widget; normally hidden but guard anyway),
  //  • the invisible reCAPTCHA response textarea,
  //  • anything inside the "Apply with LinkedIn" widget or the attachment menu.
  function shouldSkipControl(el) {
    if (!el || !isJobviteHost()) return false;
    try {
      const id = el.id || "";
      const name = el.name || "";
      if (/^jv-edit-resume-textarea/.test(id) || /^jv-paste-resume-textarea/.test(id)) return true;
      if (id === "g-recaptcha-response" || name === "g-recaptcha-response") return true;
      if (
        el.closest &&
        el.closest(
          ".awli-container, .IN-widget, #addResume, #attachResume, #captcha, .grecaptcha-badge, .jv-add-attachment"
        )
      ) {
        return true;
      }
    } catch {}
    return false;
  }

  // ── resume / cover-letter attachment ───────────────────────────────────────
  // The "Add Resume" / "Add Cover Letter" controls are custom jv-add-attachment
  // widgets (a "Select ▾" button opening a Dropbox/File/Paste/LinkedIn menu), NOT
  // standing file inputs - so the generic file driver never sees them. Opening the
  // menu reveals a REAL, visually-hidden <input type="file"
  // onchange="angular.element(this).scope().change()">. Setting its .files and
  // dispatching change runs Jobvite's own change() handler (uploads + fires
  // on-success="sendResume(...)"), exactly like a user picking a file - no OS
  // picker involved. Resume is required, so this is attached before advancing.

  // The "Select ▾" / "Add …" trigger for a given attachment kind. Jobvite tags
  // each trigger with attachment-label="Resume" | "Cover Letter" | "Portfolio".
  function attachTrigger(kind) {
    const want = kind === "cover_letter" ? "cover letter" : "resume";
    const btns = [...document.querySelectorAll("button[jv-add-attachment]")];
    let btn = btns.find((b) => clean(b.getAttribute("attachment-label") || "").toLowerCase() === want);
    if (btn) return btn;
    if (kind !== "cover_letter") {
      const inResume = document.querySelector("#attachResume button[jv-add-attachment]");
      if (inResume) return inResume;
    }
    return btns.find((b) => new RegExp(want, "i").test(clean(b.textContent))) || null;
  }

  // The attachment menu for a kind, identified by its own text (the resume menu
  // says "…Resume", the cover-letter menu "…Cover Letter"). The menu exists in the
  // DOM even while collapsed (ng-show), so it can be located without opening.
  function menuByText(kind) {
    const menus = [...document.querySelectorAll(".jv-add-attachment, #attachmentDropdown")];
    for (const m of menus) {
      const txt = clean(m.textContent);
      if (kind === "cover_letter") {
        if (/cover letter/i.test(txt)) return m;
      } else if (/resume/i.test(txt) && !/cover letter/i.test(txt)) {
        return m;
      }
    }
    return null;
  }

  function openMenuNode() {
    return (
      document.querySelector('.jv-add-attachment[aria-hidden="false"]') ||
      document.querySelector('#attachmentDropdown[aria-hidden="false"]')
    );
  }

  function fileInputInMenu(menu) {
    return (menu && menu.querySelector && menu.querySelector('input[type="file"]')) || null;
  }

  function openMenu(kind) {
    const trigger = attachTrigger(kind);
    if (!trigger) return null;
    try {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    } catch {}
    try {
      trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    } catch {}
    try {
      trigger.click();
    } catch {}
    return trigger;
  }

  function attachmentList(kind) {
    if (kind === "cover_letter") return document.querySelector(".jv-additional-files .jv-file-list");
    return document.querySelector("#attachResume .jv-file-list") || document.querySelector(".jv-file-list");
  }

  // Attached when the widget's file list shows an entry, or (resume) the "Select"
  // trigger has been replaced (its ng-show="!resumeName" wrapper is now hidden).
  function isAttached(kind) {
    try {
      const list = attachmentList(kind);
      if (list && list.querySelector("li")) return true;
      if (kind !== "cover_letter") {
        const wrap = document.querySelector('#attachResume [ng-show="!resumeName"]');
        if (wrap && !isVisible(wrap)) return true;
      }
    } catch {}
    return false;
  }

  function setFileInput(input, fileData) {
    try {
      const bin = atob(fileData.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], fileData.filename || (fileData.mime && /pdf/.test(fileData.mime) ? "resume.pdf" : "resume.docx"), {
        type: fileData.mime || "application/pdf",
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      // The inline onchange="angular.element(this).scope().change()" fires on the
      // dispatched change event; input is added for symmetry with other engines.
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  async function attachFile(kind, fileData) {
    if (!fileData || !fileData.base64) return { uploaded: false };
    if (!attachTrigger(kind)) return { uploaded: false, absent: true }; // widget not on this step
    if (isAttached(kind)) return { uploaded: true, already: true };
    // Open the widget so its Angular scope is active, then locate the revealed
    // file input (prefer the just-opened menu; fall back to the by-text menu).
    openMenu(kind);
    await waitUntil(() => {
      const n = openMenuNode() || menuByText(kind);
      return n && fileInputInMenu(n) ? true : null;
    }, 2500, 80);
    const menu = openMenuNode() || menuByText(kind);
    const input = fileInputInMenu(menu);
    if (!input) return { uploaded: false, absent: true };
    if (!setFileInput(input, fileData)) return { uploaded: false };
    const ok = await waitUntil(() => (isAttached(kind) ? true : null), 8000, 150);
    return { uploaded: !!ok };
  }

  async function uploadResume(fileData) {
    return attachFile("resume", fileData);
  }
  async function uploadCoverLetter(fileData) {
    return attachFile("cover_letter", fileData);
  }

  // ── multi-step navigation ──────────────────────────────────────────────────
  // Steps render as <div class="jv-apply-step" ng-form="scopeData.stepN"> and only
  // the CURRENT step exists in the DOM (ng-if removes the others). The footer shows
  // a "Next →" button (ng-click="nextStep()") until the last step, which shows the
  // "Send Application" submit instead. We only ever click Next.
  function currentStep() {
    try {
      const step = document.querySelector(".jv-apply-step[ng-form]");
      const m = step && /step(\d+)/i.exec(step.getAttribute("ng-form") || "");
      if (m) return Number(m[1]);
    } catch {}
    return 0;
  }

  function nextButton() {
    try {
      const direct = document.querySelector('button[ng-click="nextStep()"]');
      if (direct) return direct;
      const btns = [...document.querySelectorAll(".jv-apply-form-actions button, form button")];
      return (
        btns.find(
          (b) =>
            /next/i.test(clean(b.textContent)) &&
            String(b.getAttribute("ng-click") || "").includes("nextStep")
        ) || null
      );
    } catch {
      return null;
    }
  }

  function isFinalStep() {
    const nb = nextButton();
    if (nb && isVisible(nb)) return false;
    const submit = document.querySelector(
      'button[type="submit"][aria-label="Send Application"], .jv-apply-form-actions button[type="submit"]'
    );
    return !!(submit && isVisible(submit));
  }

  // Click "Next" and wait for the step index to increase. Returns whether the form
  // actually advanced (Jobvite blocks advance when a required field is still empty).
  async function advanceStep() {
    const nb = nextButton();
    if (!nb || !isVisible(nb)) return { advanced: false, final: isFinalStep() };
    const before = currentStep();
    try {
      nb.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    } catch {}
    try {
      nb.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    } catch {}
    try {
      nb.click();
    } catch {}
    const advanced = await waitUntil(
      () => (currentStep() > before || (before === 0 && isFinalStep()) ? true : null),
      4000,
      120
    );
    return { advanced: !!advanced && currentStep() > before, final: isFinalStep() };
  }

  // Some Jobvite forms mark a free-text field as required even though it only
  // applies conditionally - e.g. CMG's "If yes, please describe below…" which is
  // required regardless of the paired Yes/No answer. When the answer is negative
  // the model correctly leaves it blank, but Jobvite then blocks "Next" with
  // "Please provide this information." After the model has had its passes, fill any
  // still-empty VISIBLE required free-text field with "N/A" so validation passes
  // and the step can advance (we never auto-submit; the user reviews before
  // sending). Restricted to <input type="text"> / <textarea>: email/tel/number/url
  // fields carry patterns that "N/A" would fail, and select/radio/checkbox have
  // their own handling. Widget-owned controls (paste boxes, reCAPTCHA, LinkedIn)
  // are excluded via shouldSkipControl.
  function fillRequiredPlaceholders(placeholder) {
    const val = placeholder || "N/A";
    const root = applicationForm() || document;
    let count = 0;
    let controls = [];
    try {
      controls = [...root.querySelectorAll("input, textarea")];
    } catch {
      controls = [];
    }
    for (const el of controls) {
      try {
        const tag = (el.tagName || "").toLowerCase();
        if (tag !== "input" && tag !== "textarea") continue;
        if (tag === "input" && (el.type || "text").toLowerCase() !== "text") continue;
        if (shouldSkipControl(el)) continue;
        if (!isVisible(el)) continue;
        if (!isRequiredControl(el)) continue;
        if (clean(el.value)) continue; // already answered
        setNativeValue(el, val);
        fireInput(el);
        try {
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } catch {}
        count++;
      } catch {}
    }
    return count;
  }

  AF.jobvite = {
    isJobviteHost,
    isJobvitePage,
    applicationForm,
    questionTitleFor,
    isRequiredControl,
    shouldSkipControl,
    currentStep,
    isFinalStep,
    advanceStep,
    uploadResume,
    uploadCoverLetter,
    isAttached,
    fillRequiredPlaceholders,
  };
})();
