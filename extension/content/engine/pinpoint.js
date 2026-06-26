// Pinpoint HQ (careers.[company].com) helpers - React-on-Rails application forms.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean } = AF.dom;

  function isPinpointPage() {
    try {
      if (document.querySelector("form#application-form.external-form, form.external-form")) return true;
      return !!document.querySelector(
        'script.js-react-on-rails-component[data-component-name^="Shared::Form::"]'
      );
    } catch {
      return false;
    }
  }

  // Question title from Pinpoint's external-form wrappers (boolean radios,
  // react-select questions, hidden metadata fields).
  function questionTitleFor(el) {
    if (!el) return "";
    try {
      const block = el.closest && el.closest(".pad-v-3, .col-md-1-1");
      if (block) {
        const title = block.querySelector(".external-form__label--title");
        if (title && clean(title.textContent)) return clean(title.textContent).slice(0, 200);
        const hid = block.querySelector('input[type="hidden"][name*="[title]"]');
        if (hid && clean(hid.value)) return clean(hid.value).slice(0, 200);
      }
      const field = el.closest && el.closest(".frow, .col-md-1-1");
      if (field) {
        const lbl = field.querySelector("label.external-form__label .external-form__label--title");
        if (lbl && clean(lbl.textContent)) return clean(lbl.textContent).slice(0, 200);
      }
    } catch {}
    return "";
  }

  // Harvest option labels from the adjacent React-on-Rails JSON bootstrap script.
  function rorOptionsFor(el) {
    if (!el) return [];
    try {
      let node = el.closest && el.closest("[id*='-react-component-']");
      if (!node) node = el.parentElement;
      for (let depth = 0; node && depth < 6; depth++) {
        const sib = node.nextElementSibling;
        if (sib && sib.matches && sib.matches("script.js-react-on-rails-component")) {
          const domId = sib.getAttribute("data-dom-id");
          const hostId = node.id || "";
          if (!domId || domId === hostId || hostId.includes("react-component")) {
            const data = JSON.parse(sib.textContent || "{}");
            const opts = data.options;
            if (Array.isArray(opts) && opts.length) {
              return opts
                .map((o) => clean(typeof o === "string" ? o : o.label || o.value || ""))
                .filter(Boolean);
            }
          }
        }
        const prev = node.previousElementSibling;
        if (prev && prev.matches && prev.matches("script.js-react-on-rails-component")) {
          const data = JSON.parse(prev.textContent || "{}");
          const opts = data.options;
          if (Array.isArray(opts) && opts.length) {
            return opts
              .map((o) => clean(typeof o === "string" ? o : o.label || o.value || ""))
              .filter(Boolean);
          }
        }
        node = node.parentElement;
      }
      for (const script of document.querySelectorAll("script.js-react-on-rails-component")) {
        const domId = script.getAttribute("data-dom-id") || "";
        const host = domId && document.getElementById(domId);
        if (!host || !host.contains(el)) continue;
        const data = JSON.parse(script.textContent || "{}");
        const opts = data.options;
        if (Array.isArray(opts) && opts.length) {
          return opts
            .map((o) => clean(typeof o === "string" ? o : o.label || o.value || ""))
            .filter(Boolean);
        }
      }
    } catch {}
    return [];
  }

  function syncPhoneIso2(itiRoot) {
    if (!itiRoot) return false;
    try {
      const tel = itiRoot.querySelector('input[type="tel"]');
      const flag = itiRoot.querySelector(".iti__selected-flag");
      const isoHidden =
        document.getElementById("phone-country-code-dropdown") ||
        itiRoot.querySelector('input[name*="phone_iso2"], input[name*="[phone_iso2]"]');
      if (!isoHidden) return false;
      let iso = "";
      const li = itiRoot.querySelector(".iti__country-list .iti__active, .iti__country-list .highlight");
      if (li) iso = (li.getAttribute("data-country-code") || "").toUpperCase();
      if (!iso && flag) {
        const cls = [...(flag.classList || [])].find((c) => /^iti__/.test(c) && c !== "iti__flag");
        if (cls) iso = cls.replace("iti__", "").toUpperCase();
      }
      if (!iso && tel && tel.value && /^\+\s*1\b/.test(tel.value)) iso = "US";
      if (!iso) return false;
      isoHidden.value = iso;
      isoHidden.dispatchEvent(new Event("input", { bubbles: true }));
      isoHidden.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  function tickPinpointConsent() {
    const box = document.getElementById("application_process_information");
    if (!box || box.checked) return box ? 1 : 0;
    const targets = [box];
    const label = document.querySelector('label[for="application_process_information"]');
    if (label) targets.push(label);
    const wrap = box.closest && box.closest(".pretty, .state");
    if (wrap) targets.push(wrap);
    for (const t of targets) {
      try {
        t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        t.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        t.click();
      } catch {}
      if (box.checked) break;
    }
    if (!box.checked) {
      box.checked = true;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return box.checked ? 1 : 0;
  }

  AF.pinpoint = {
    isPinpointPage,
    questionTitleFor,
    rorOptionsFor,
    syncPhoneIso2,
    tickPinpointConsent,
  };
})();
