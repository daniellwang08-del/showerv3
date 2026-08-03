// Manatal (careers-page.com) application form helpers.
//
// Manatal careers pages render a single Vue form of native controls:
//   .form-group > label + input/textarea/file, plus a terms checkbox and Apply.
// Labels use empty for="" so label[for=id] never matches; question text lives in
// the sibling .form-group > label (or a sibling <span> for the consent box).
// Reuses the greenhouse select/LLM bundle; this module only owns label/required
// resolution and ticking the required terms checkbox.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean } = AF.dom;

  function isManatalHost() {
    try {
      const h = location.hostname || "";
      return /(^|\.)careers-page\.com$/i.test(h) || /(^|\.)manatal\.com$/i.test(h);
    } catch {
      return false;
    }
  }

  function hasManatalForm() {
    try {
      return !!document.querySelector(
        "#app form .form-group input.form-control, " +
          "#app form .custom-file-input, " +
          'form input[name="terms_and_condition"], ' +
          "form .btn-apply, " +
          'form button#submit-id-submit'
      );
    } catch {
      return false;
    }
  }

  function isManatalPage() {
    try {
      if (isManatalHost() && hasManatalForm()) return true;
      if (isManatalHost()) return !!document.querySelector("#app form, form .form-group");
      // White-label shells that still ship Manatal's form markers.
      return !!(
        document.querySelector('form input[name="terms_and_condition"]') &&
        document.querySelector("form .form-group input.form-control, form .custom-file-input")
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

  function formGroup(el) {
    return (el && el.closest && el.closest(".form-group")) || null;
  }

  // Question title for a control. Prefer the .form-group label (empty for="") over
  // placeholder so "Full Name: *" becomes "Full Name". Consent checkboxes sit
  // outside .form-group next to a sibling <span> with the agree text.
  function questionTitleFor(el) {
    if (!el || !isManatalPage()) return "";
    try {
      const t = (el.type || "").toLowerCase();
      if (t === "checkbox" || t === "radio") {
        const wrap = el.parentElement;
        if (wrap) {
          const sp = wrap.querySelector(":scope > span");
          if (sp && clean(sp.innerText)) return clean(sp.innerText).slice(0, 200);
          if (clean(wrap.innerText)) return clean(wrap.innerText).slice(0, 200);
        }
        return "";
      }
      const grp = formGroup(el);
      if (grp) {
        let lab = null;
        try {
          lab = grp.querySelector(":scope > label");
        } catch {
          lab = grp.querySelector("label");
        }
        // Skip the Bootstrap custom-file "Choose file" label inside the control.
        if (lab && lab.classList && lab.classList.contains("custom-file-label")) {
          lab = null;
          const labels = grp.querySelectorAll("label");
          for (const l of labels) {
            if (l.classList && l.classList.contains("custom-file-label")) continue;
            lab = l;
            break;
          }
        }
        if (lab && clean(lab.textContent)) return stripLabel(lab.textContent).slice(0, 200);
      }
    } catch {}
    return "";
  }

  // Manatal marks required fields with a red * in the label, not HTML required.
  function isRequiredControl(el) {
    if (!el || !isManatalPage()) return false;
    try {
      if (el.required || (el.getAttribute && el.getAttribute("aria-required") === "true")) return true;
      const t = (el.type || "").toLowerCase();
      if (t === "checkbox" && /terms_and_condition/i.test(el.name || "")) return true;
      const grp = formGroup(el);
      if (!grp) return false;
      const lab = grp.querySelector("label:not(.custom-file-label)");
      if (lab && /\*/.test(lab.textContent || "")) return true;
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
      document
        .querySelectorAll(
          'input[type="checkbox"][name="terms_and_condition"], input[type="checkbox"][name="terms_and_conditions"]'
        )
        .forEach(add);
      // Fallback: unchecked box whose sibling text mentions terms/privacy.
      document.querySelectorAll('#app form input[type="checkbox"], form .mt-3 input[type="checkbox"]').forEach((el) => {
        if (seen.has(el)) return;
        const wrap = el.parentElement;
        const txt = clean((wrap && wrap.innerText) || "");
        if (/\bterms\b|\bprivacy\b|i agree/i.test(txt)) add(el);
      });
    } catch {}
    return out;
  }

  // Tick the required terms/privacy consent checkbox(es). Returns how many were
  // newly checked (already-checked boxes do not count).
  function tickConsent() {
    if (!isManatalPage()) return 0;
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

  function applicationForm() {
    try {
      return (
        document.querySelector("#app form") ||
        document.querySelector("form:has(.btn-apply)") ||
        document.querySelector("form:has(.custom-file-input)") ||
        document.querySelector('form:has(input[name="terms_and_condition"])') ||
        null
      );
    } catch {
      const btn = document.querySelector("form .btn-apply");
      if (btn && btn.closest) return btn.closest("form");
      return document.querySelector("#app form");
    }
  }

  AF.manatal = {
    isManatalHost,
    isManatalPage,
    questionTitleFor,
    isRequiredControl,
    tickConsent,
    consentCheckboxes,
    applicationForm,
  };
})();
